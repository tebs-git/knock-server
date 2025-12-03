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

// ✅ Get complete public IP address
function getCompletePublicIp(req) {
  const ip = req.headers['x-forwarded-for'] || 
              req.connection.remoteAddress || 
              req.socket.remoteAddress ||
              req.ip ||
              'unknown';
  
  let completeIp = ip;
  if (ip.includes(',')) {
    completeIp = ip.split(',')[0].trim();
  }
  
  completeIp = completeIp.replace(/^::ffff:/, '');
  return completeIp;
}

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Create group
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) return res.status(400).json({ error: "token and groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const publicIp = getCompletePublicIp(req);
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: {
        [token]: {
          publicIp: publicIp,
          lastUpdated: new Date().toISOString()
        }
      }
    });

    console.log(`Group created: ${groupName} (${groupCode}) - Creator IP: ${publicIp}`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Create group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const publicIp = getCompletePublicIp(req);
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${token}`]: {
        publicIp: publicIp,
        lastUpdated: new Date().toISOString()
      }
    });

    const groupData = groupDoc.data();
    console.log(`Token ${token.substring(0, 10)}... joined group ${groupCode} (IP: ${publicIp})`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send knock (SIMPLIFIED - compares IPs directly in group)
app.post("/send-knock", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const senderIp = getCompletePublicIp(req);
    console.log(`Knock attempt: ${token.substring(0, 10)}... (IP: ${senderIp}) to group ${groupCode}`);

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    
    // Check if sender is in the group
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a group member" });
    }

    // Update sender's IP (in case it changed)
    await groupRef.update({
      [`members.${token}.publicIp`]: senderIp,
      [`members.${token}.lastUpdated`]: new Date().toISOString()
    });

    // Find other members with same IP
    const tokensToNotify = [];
    
    for (const [memberToken, memberData] of Object.entries(groupData.members)) {
      if (memberToken !== token && memberData.publicIp === senderIp) {
        tokensToNotify.push(memberToken);
      }
    }

    console.log(`IP match check: ${senderIp} found ${tokensToNotify.length} matching members`);

    if (tokensToNotify.length === 0) {
      return res.status(400).json({ error: "No one home (different network)" });
    }

    // Send FCM to all matching members
    const message = {
      tokens: tokensToNotify,
      data: {
        title: "🔔 Knock Knock!",
        body: "Someone is at the door!",
        type: "knock",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ Knock delivered to ${tokensToNotify.length} member(s) on same network (${senderIp})`);
    res.json({ success: true, count: tokensToNotify.length, message: "Knock delivered" });
  } catch (err) {
    console.error("Send knock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get user's groups
app.post("/my-groups", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          memberCount: Object.keys(groupData.members).length,
        });
      }
    });

    console.log(`Found ${userGroups.length} groups for token ${token.substring(0, 10)}...`);
    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
});
