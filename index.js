const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const firestore = admin.firestore();
const app = express();

// ✅ EXACT PLACE: right after const app = express();
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());

const pendingKnocks = new Map();

function getCompletePublicIp(req) {
  let ip = req.headers["x-forwarded-for"];
  if (ip) {
    const ipChain = ip.split(",").map((i) => i.trim());
    const clientIp = ipChain[0];
    return clientIp.replace(/^::ffff:/, "");
  }
  ip =
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    (req.socket && req.socket.remoteAddress) ||
    "unknown";
  return ip.replace(/^::ffff:/, "");
}

async function requireAuth(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) throw new Error("Missing Authorization Bearer token");
  const decoded = await admin.auth().verifyIdToken(match[1]);
  return { uid: decoded.uid };
}

async function setUserActiveGroup(uid, groupCode) {
  await firestore.collection("user_preferences").doc(uid).set(
    { active_group: groupCode, last_updated: new Date().toISOString() },
    { merge: true }
  );
}

async function getUserActiveGroup(uid) {
  const prefDoc = await firestore.collection("user_preferences").doc(uid).get();
  if (!prefDoc.exists) return null;
  const data = prefDoc.data();
  return data.active_group || null;
}

// Device token registry: /user_devices/{uid}/tokens/{fcmToken}
async function getUserFcmTokens(uid) {
  const snap = await firestore
    .collection("user_devices")
    .doc(uid)
    .collection("tokens")
    .get();
  return snap.docs.map((d) => d.id);
}

app.get("/health", (req, res) => res.json({ status: "OK" }));

app.post("/register-device", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);
    const { fcmToken, platform } = req.body;

    if (!fcmToken) return res.status(400).json({ error: "fcmToken required" });

    await firestore.collection("user_devices").doc(uid).set(
      { updatedAt: Date.now() },
      { merge: true }
    );

    await firestore
      .collection("user_devices")
      .doc(uid)
      .collection("tokens")
      .doc(fcmToken)
      .set(
        { platform: platform || "android", updatedAt: Date.now() },
        { merge: true }
      );

    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ===== Groups =====

app.post("/create-group", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);
    const { groupName } = req.body;
    if (!groupName) return res.status(400).json({ error: "groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: { [uid]: { joinedAt: Date.now() } },
    });

    await setUserActiveGroup(uid, groupCode);

    res.json({ success: true, groupCode, groupName, is_active: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/join-group", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const clean = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(clean);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({ [`members.${uid}`]: { joinedAt: Date.now() } });
    await setUserActiveGroup(uid, clean);

    const groupData = groupDoc.data();
    res.json({ success: true, groupName: groupData.name, groupCode: clean, is_active: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/my-groups", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);

    let activeGroup = await getUserActiveGroup(uid);
    const groupsSnapshot = await firestore.collection("groups").get();

    const userGroups = [];
    const userGroupCodes = [];

    groupsSnapshot.forEach((doc) => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[uid]) {
        userGroupCodes.push(doc.id);
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          memberCount: Object.keys(groupData.members).length,
          is_active: doc.id === activeGroup,
        });
      }
    });

    if (userGroups.length > 0 && !activeGroup) {
      activeGroup = userGroupCodes[0];
      await setUserActiveGroup(uid, activeGroup);
      userGroups.forEach((g) => (g.is_active = g.groupCode === activeGroup));
    }

    res.json({ success: true, groups: userGroups, active_group: activeGroup });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/set-active-group", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const clean = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(clean);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    if (!groupData.members || !groupData.members[uid]) return res.status(403).json({ error: "Not a member" });

    await setUserActiveGroup(uid, clean);
    res.json({ success: true, groupCode: clean, groupName: groupData.name });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/get-active-group", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);

    const activeGroupCode = await getUserActiveGroup(uid);
    if (!activeGroupCode) return res.json({ success: true, has_active_group: false });

    const groupRef = firestore.collection("groups").doc(activeGroupCode);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) {
      await firestore.collection("user_preferences").doc(uid).set({ active_group: null }, { merge: true });
      return res.json({ success: true, has_active_group: false });
    }

    const groupData = groupDoc.data();
    res.json({ success: true, has_active_group: true, groupCode: activeGroupCode, groupName: groupData.name });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ===== Knock flow =====

app.post("/knock-attempt", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);
    let { groupCode } = req.body;

    if (!groupCode) {
      const active = await getUserActiveGroup(uid);
      if (!active) return res.status(400).json({ error: "groupCode required (no active group)" });
      groupCode = active;
    }

    const senderIp = getCompletePublicIp(req);
    const clean = groupCode.toUpperCase();

    const groupRef = firestore.collection("groups").doc(clean);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = groupData.members || {};
    if (!members[uid]) return res.status(403).json({ error: "Not a member" });

    const knockId = Date.now().toString();
    pendingKnocks.set(knockId, { knockId, senderUid: uid, senderIp, groupCode: clean, timestamp: Date.now() });
    setTimeout(() => pendingKnocks.delete(knockId), 20000);

    const receiverUids = Object.keys(members).filter((m) => m !== uid);
    if (receiverUids.length === 0) return res.status(400).json({ success: false, error: "No one else in group" });

    const sendPromises = [];
    for (const ruid of receiverUids) {
      const tokens = await getUserFcmTokens(ruid);
      for (const t of tokens) {
        sendPromises.push(
          admin.messaging().send({
            token: t,
            data: {
              title: "🔍 Knock Attempt",
              body: "Someone is checking if you're home...",
              type: "knock-attempt",
              knockId,
            },
            android: { priority: "high", notification: { sound: null, defaultSound: false } },
          })
        );
      }
    }

    await Promise.all(sendPromises);

    res.json({ success: true, message: `Checking ${receiverUids.length} person(s)...`, knockId, count: receiverUids.length });
  } catch (err) {
    console.error("Knock attempt error:", err);
    res.status(401).json({ success: false, error: err.message });
  }
});

app.post("/report-ip", async (req, res) => {
  try {
    const { uid } = await requireAuth(req);
    const { knockId } = req.body;
    if (!knockId) return res.status(400).json({ error: "knockId required" });

    const receiverIp = getCompletePublicIp(req);
    const pendingData = pendingKnocks.get(knockId);
    if (!pendingData) return res.status(404).json({ error: "Knock attempt expired" });

    const groupRef = firestore.collection("groups").doc(pendingData.groupCode);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    if (!groupData.members || !groupData.members[uid]) return res.status(403).json({ error: "Not a member" });

    const isSameNetwork = receiverIp === pendingData.senderIp;

    if (isSameNetwork) {
      const tokens = await getUserFcmTokens(uid);
      if (tokens.length > 0) {
        await Promise.all(
          tokens.map((t) =>
            admin.messaging().send({
              token: t,
              data: { title: "🚪 Door Knock!", body: "Someone is at your door!", type: "actual-knock" },
              android: { priority: "high" },
            })
          )
        );
      }
    }

    res.json({ success: true, isSameNetwork });
  } catch (err) {
    console.error("Report IP error:", err);
    res.status(401).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
