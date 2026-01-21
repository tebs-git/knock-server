const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const firestore = admin.firestore();
const app = express();

// ✅ Good idea on Render/Proxies so req.ip behaves
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());

const pendingKnocks = new Map();

function getCompletePublicIp(req) {
  let ip = req.headers['x-forwarded-for'];
  if (ip) {
    const ipChain = ip.split(',').map(i => i.trim());
    const clientIp = ipChain[0];
    return clientIp.replace(/^::ffff:/, '');
  }
  ip = req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
  return ip.replace(/^::ffff:/, '');
}

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

// ✅ Fix #2: Auth middleware (UID identity)
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: "Missing Authorization: Bearer <ID_TOKEN>" });

    const idToken = match[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "Invalid auth token" });
  }
}

async function setUserActiveGroup(uid, groupCode) {
  try {
    await firestore.collection("user_preferences").doc(uid).set({
      active_group: groupCode,
      last_updated: new Date().toISOString()
    }, { merge: true });
    return true;
  } catch (err) {
    console.error("Error setting active group:", err);
    throw err;
  }
}

async function getUserActiveGroup(uid) {
  try {
    const prefDoc = await firestore.collection("user_preferences").doc(uid).get();
    if (prefDoc.exists) {
      const data = prefDoc.data();
      return data.active_group || null;
    }
    return null;
  } catch (err) {
    console.error("Error getting active group:", err);
    return null;
  }
}

// ✅ Fix #2: device registry (uid -> FCM tokens)
app.post("/register-device", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const fcmToken = req.body.fcmToken || req.body.token; // support both
    if (!fcmToken) return res.status(400).json({ error: "token (FCM token) required" });

    const ref = firestore.collection("user_devices").doc(uid);
    await ref.set({
      updatedAt: Date.now(),
      tokens: {
        [fcmToken]: { updatedAt: Date.now() }
      }
    }, { merge: true });

    res.json({ success: true });
  } catch (err) {
    console.error("Register device error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function getUserDeviceTokens(uid) {
  try {
    const doc = await firestore.collection("user_devices").doc(uid).get();
    if (!doc.exists) return [];
    const data = doc.data() || {};
    const tokensObj = data.tokens || {};
    return Object.keys(tokensObj);
  } catch (e) {
    console.error("getUserDeviceTokens error:", e);
    return [];
  }
}

// ✅ Create group
app.post("/create-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupName } = req.body;
    if (!groupName) return res.status(400).json({ error: "groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: {
        [uid]: { joinedAt: Date.now() }
      }
    });

    await setUserActiveGroup(uid, groupCode);

    res.json({ success: true, groupCode, groupName, is_active: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group
app.post("/join-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const cleanGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(cleanGroupCode);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${uid}`]: { joinedAt: Date.now() }
    });

    await setUserActiveGroup(uid, cleanGroupCode);

    const groupData = groupDoc.data();
    res.json({ success: true, groupName: groupData.name, groupCode: cleanGroupCode, is_active: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ My groups
app.post("/my-groups", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;

    let activeGroup = await getUserActiveGroup(uid);

    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];
    const userGroupCodes = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[uid]) {
        userGroupCodes.push(doc.id);
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          memberCount: Object.keys(groupData.members).length,
          is_active: (doc.id === activeGroup)
        });
      }
    });

    if (userGroups.length > 0 && !activeGroup) {
      activeGroup = userGroupCodes[0];
      await setUserActiveGroup(uid, activeGroup);

      userGroups.forEach(group => {
        group.is_active = (group.groupCode === activeGroup);
      });
    }

    res.json({
      success: true,
      groups: userGroups,
      active_group: activeGroup
    });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Set active group
app.post("/set-active-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const cleanGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(cleanGroupCode);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    if (!groupData.members || !groupData.members[uid]) {
      return res.status(403).json({ error: "Not a member" });
    }

    await setUserActiveGroup(uid, cleanGroupCode);

    res.json({ success: true, groupCode: cleanGroupCode, groupName: groupData.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get active group
app.post("/get-active-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;

    const activeGroupCode = await getUserActiveGroup(uid);

    if (!activeGroupCode) {
      return res.json({ success: true, has_active_group: false });
    }

    const groupRef = firestore.collection("groups").doc(activeGroupCode);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) {
      await firestore.collection("user_preferences").doc(uid).set({
        active_group: null
      }, { merge: true });
      return res.json({ success: true, has_active_group: false });
    }

    const groupData = groupDoc.data();
    res.json({
      success: true,
      has_active_group: true,
      groupCode: activeGroupCode,
      groupName: groupData.name
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ✅ Knock attempt
app.post("/knock-attempt", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupCode } = req.body;
    if (!groupCode) {
      return res.status(400).json({ error: "groupCode required" });
    }

    const senderIp = getCompletePublicIp(req);
    const cleanGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(cleanGroupCode);
    const groupDoc = await groupRef.get();

    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = groupData.members || {};

    if (!members[uid]) {
      return res.status(403).json({ error: "Not a member" });
    }

    const activeGroup = await getUserActiveGroup(uid);
    if (activeGroup !== cleanGroupCode) {
      console.log(`Knocking from non-active group`);
    }

    const knockId = Date.now().toString();
    const pendingData = {
      knockId,
      senderUid: uid,
      senderIp,
      groupCode: cleanGroupCode,
      timestamp: Date.now(),
      receiversReported: new Set()
    };

    pendingKnocks.set(knockId, pendingData);

    setTimeout(() => {
      pendingKnocks.delete(knockId);
    }, 20000);

    const receiverUids = Object.keys(members).filter(m => m !== uid);

    if (receiverUids.length === 0) {
      return res.status(400).json({ success: false, error: "No one else in group" });
    }

    // Send knock-attempt to all devices of all receiver UIDs
    const sendPromises = [];
    for (const receiverUid of receiverUids) {
      const tokens = await getUserDeviceTokens(receiverUid);
      for (const t of tokens) {
        sendPromises.push(admin.messaging().send({
          token: t,
          data: {
            title: "🔍 Knock Attempt",
            body: "Someone is checking if you're home...",
            type: "knock-attempt",
            knockId: knockId,
            senderUid: uid
          },
          android: {
            priority: "high",
            notification: {
              sound: null,
              defaultSound: false
            }
          }
        }));
      }
    }

    await Promise.all(sendPromises);

    console.log(`Knock attempt sent`);

    res.json({
      success: true,
      message: `Checking ${receiverUids.length} person(s)...`,
      knockId: knockId,
      count: receiverUids.length
    });

  } catch (err) {
    console.error("Knock attempt error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Report IP
app.post("/report-ip", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { knockId } = req.body;
    if (!knockId) {
      return res.status(400).json({ error: "knockId required" });
    }

    const receiverIp = getCompletePublicIp(req);
    const pendingData = pendingKnocks.get(knockId);
    if (!pendingData) return res.status(404).json({ error: "Knock attempt expired" });

    const groupRef = firestore.collection("groups").doc(pendingData.groupCode);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    if (!groupData.members || !groupData.members[uid]) {
      return res.status(403).json({ error: "Not a member" });
    }

    pendingData.receiversReported.add(uid);
    const isSameNetwork = (receiverIp === pendingData.senderIp);

    setTimeout(async () => {
      try {
        if (isSameNetwork && pendingKnocks.has(knockId)) {
          const tokens = await getUserDeviceTokens(uid);
          const sends = tokens.map(t => admin.messaging().send({
            token: t,
            data: {
              title: "🚪 Door Knock!",
              body: "Someone is at your door!",
              type: "actual-knock"
            },
            android: { priority: "high" }
          }));
          await Promise.all(sends);
          console.log(`Actual knock sent`);
        }
      } catch (e) {
        console.error("Error sending actual knock:", e);
      }
    }, 2000);

    res.json({ success: true, isSameNetwork: isSameNetwork });
  } catch (err) {
    console.error("Report IP error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
