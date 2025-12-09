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

async function setUserActiveGroup(token, groupCode) {
  try {
    await firestore.collection("user_preferences").doc(token).set({
      active_group: groupCode,
      last_updated: new Date().toISOString()
    }, { merge: true });
    console.log(`✓ Active group set for ${token.substring(0, 8)}...: ${groupCode}`);
    return true;
  } catch (err) {
    console.error("Error setting active group:", err);
    throw err;
  }
}

async function getUserActiveGroup(token) {
  try {
    const prefDoc = await firestore.collection("user_preferences").doc(token).get();
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

app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) return res.status(400).json({ error: "token and groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: { 
        [token]: { joinedAt: Date.now() } 
      }
    });

    await setUserActiveGroup(token, groupCode);
    
    res.json({ success: true, groupCode, groupName, is_active: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const cleanGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(cleanGroupCode);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${token}`]: { joinedAt: Date.now() }
    });

    await setUserActiveGroup(token, cleanGroupCode);

    const groupData = groupDoc.data();
    res.json({ success: true, groupName: groupData.name, groupCode: cleanGroupCode, is_active: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/my-groups", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    console.log(`📱 Loading groups for ${token.substring(0, 8)}...`);
    
    let activeGroup = await getUserActiveGroup(token);
    console.log(`   Current active group: ${activeGroup || "none"}`);
    
    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];
    const userGroupCodes = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        userGroupCodes.push(doc.id);
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          memberCount: Object.keys(groupData.members).length,
          is_active: (doc.id === activeGroup)
        });
      }
    });

    console.log(`   Found ${userGroups.length} groups for user`);
    
    if (userGroups.length > 0 && !activeGroup) {
      activeGroup = userGroupCodes[0];
      await setUserActiveGroup(token, activeGroup);
      console.log(`   🔄 Auto-set active group to: ${activeGroup}`);
      
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

app.post("/set-active-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const cleanGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(cleanGroupCode);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });
    
    const groupData = groupDoc.data();
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a member" });
    }

    await setUserActiveGroup(token, cleanGroupCode);
    
    res.json({ success: true, groupCode: cleanGroupCode, groupName: groupData.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/get-active-group", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const activeGroupCode = await getUserActiveGroup(token);
    
    if (!activeGroupCode) {
      return res.json({ success: true, has_active_group: false });
    }

    const groupRef = firestore.collection("groups").doc(activeGroupCode);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      await firestore.collection("user_preferences").doc(token).update({
        active_group: null
      });
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

// ✅ Knock attempt - SILENT notification (no sound)
app.post("/knock-attempt", async (req, res) => {
  try {
    const { senderToken, groupCode } = req.body;
    if (!senderToken || !groupCode) {
      return res.status(400).json({ error: "senderToken and groupCode required" });
    }

    const senderIp = getCompletePublicIp(req);
    const cleanGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(cleanGroupCode);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = groupData.members || {};
    
    if (!members[senderToken]) {
      return res.status(403).json({ error: "Not a member" });
    }

    const activeGroup = await getUserActiveGroup(senderToken);
    if (activeGroup !== cleanGroupCode) {
      console.log(`⚠️  ${senderToken.substring(0, 8)}... knocking from non-active group`);
    }

    const knockId = Date.now().toString();
    const pendingData = {
      knockId,
      senderToken,
      senderIp,
      groupCode: cleanGroupCode,
      timestamp: Date.now(),
      receiversReported: new Set()
    };
    
    pendingKnocks.set(knockId, pendingData);
    
    setTimeout(() => {
      pendingKnocks.delete(knockId);
    }, 20000);

    const receiverTokens = Object.keys(members).filter(t => t !== senderToken);
    
    if (receiverTokens.length === 0) {
      return res.status(400).json({ success: false, error: "No one else in group" });
    }

    const messages = receiverTokens.map(token => ({
      token: token,
      data: {
        title: "🔍 Knock Attempt",
        body: "Someone is checking if you're home...",
        type: "knock-attempt",
        knockId: knockId,
        senderToken: senderToken
      },
      android: { 
        priority: "high",
        notification: {
          sound: null,  // NO SOUND for knock-attempt
          defaultSound: false
        }
      }
    }));

    await Promise.all(messages.map(msg => admin.messaging().send(msg)));
    
    console.log(`📤 Silent knock attempt from ${senderToken.substring(0, 8)}... to ${receiverTokens.length} receivers`);
    
    res.json({ 
      success: true, 
      message: `Checking ${receiverTokens.length} person(s)...`,
      knockId: knockId,
      count: receiverTokens.length
    });

  } catch (err) {
    console.error("Knock attempt error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Report IP
app.post("/report-ip", async (req, res) => {
  try {
    const { token, knockId } = req.body;
    if (!token || !knockId) {
      return res.status(400).json({ error: "token and knockId required" });
    }

    const receiverIp = getCompletePublicIp(req);
    const pendingData = pendingKnocks.get(knockId);
    if (!pendingData) return res.status(404).json({ error: "Knock attempt expired" });

    const groupRef = firestore.collection("groups").doc(pendingData.groupCode);
    const groupDoc = await groupRef.get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a member" });
    }

    pendingData.receiversReported.add(token);
    const isSameNetwork = (receiverIp === pendingData.senderIp);
    
    console.log(`📱 ${token.substring(0, 8)}... IP: ${receiverIp}, Match: ${isSameNetwork}`);
    
    setTimeout(async () => {
    if (isSameNetwork && pendingKnocks.has(knockId)) {
        const message = {
            token: token,
            data: {
                title: "🚪 Door Knock!",
                body: "Someone is at your door!",
                type: "actual-knock"
            },
            android: { 
                priority: "high"
                // REMOVE sound settings - we'll play custom sound in app
            }
        };
        await admin.messaging().send(message);
        console.log(`✅ Actual knock sent to ${token.substring(0, 8)}...`);
     }
  }, 3000);

    res.json({ success: true, isSameNetwork: isSameNetwork });
  } catch (err) {
    console.error("Report IP error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 WiFi Knock Knock Server on port ${PORT}`);
  console.log(`📊 Active group tracking: ENABLED`);
  console.log(`🎯 Knock-attempt: SILENT, Actual-knock: WITH SOUND`);
});

