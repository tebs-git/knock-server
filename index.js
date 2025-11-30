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

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Register device and report status
app.post("/register", async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) return res.status(400).json({ error: "token and userId required" });

    const publicIp = req.ip.replace(/^::ffff:/, '');
    
    // Store in device_status collection
    await firestore.collection("device_status").doc(userId).set({
      fcm_token: token,
      public_ip: publicIp,
      last_seen: new Date().toISOString(),
    });

    console.log(`Registered: ${userId} (IP: ${publicIp})`);
    res.json({ success: true });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Report device status (IP update)
app.post("/report-status", async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) return res.status(400).json({ error: "token and userId required" });

    const publicIp = req.ip.replace(/^::ffff:/, '');
    
    await firestore.collection("device_status").doc(userId).set({
      fcm_token: token,
      public_ip: publicIp,
      last_seen: new Date().toISOString(),
    }, { merge: true });

    console.log(`Status updated: ${userId} -> ${publicIp}`);
    res.json({ success: true, public_ip: publicIp });
  } catch (err) {
    console.error("Status update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create group
app.post("/create-group", async (req, res) => {
  try {
    const { groupName, userId } = req.body;
    if (!groupName || !userId) return res.status(400).json({ error: "groupName and userId required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdBy: userId,
      createdAt: Date.now(),
      members: { [userId]: { joinedAt: Date.now() } }
    });

    console.log(`Group created: ${groupName} (${groupCode}) by ${userId}`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Create group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group
app.post("/join-group", async (req, res) => {
  try {
    const { groupCode, userId } = req.body;
    if (!groupCode || !userId) return res.status(400).json({ error: "groupCode and userId required" });

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${userId}`]: { joinedAt: Date.now() }
    });

    const groupData = groupDoc.data();
    console.log(`User ${userId} joined group ${groupCode}`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send knock (Core functionality)
app.post("/send-knock", async (req, res) => {
  try {
    const { senderUserId, receiverUserId } = req.body;
    if (!senderUserId || !receiverUserId) return res.status(400).json({ error: "senderUserId and receiverUserId required" });

    const senderIp = req.ip.replace(/^::ffff:/, '');
    
    // Get receiver's status
    const receiverDoc = await firestore.collection("device_status").doc(receiverUserId).get();
    if (!receiverDoc.exists) return res.status(404).json({ error: "Receiver not found" });

    const receiverData = receiverDoc.data();
    const receiverIp = receiverData.public_ip;
    const receiverToken = receiverData.fcm_token;

    if (!receiverToken) return res.status(404).json({ error: "Receiver token not available" });

    // Proximity check
    if (senderIp === receiverIp) {
      // Send FCM notification
      await admin.messaging().send({
        token: receiverToken,
        data: { type: "knock", timestamp: new Date().toISOString(), senderId: senderUserId },
        android: { priority: "high" },
      });

      console.log(`✅ Knock delivered: ${senderUserId} -> ${receiverUserId}`);
      res.json({ success: true, message: "Knock delivered" });
    } else {
      console.log(`🚫 Knock blocked: Different networks (${senderIp} vs ${receiverIp})`);
      res.status(400).json({ error: "Knock failed (remote location)" });
    }
  } catch (err) {
    console.error("Send knock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get user's groups
app.post("/my-groups", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[userId]) {
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          memberCount: Object.keys(groupData.members).length,
        });
      }
    });

    userGroups.sort((a, b) => b.joinedAt - a.joinedAt);
    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get group members
app.post("/group-members", async (req, res) => {
  try {
    const { groupCode, currentUserId } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const groupDoc = await firestore.collection("groups").doc(groupCode.toUpperCase()).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = [];

    for (const [memberUserId] of Object.entries(groupData.members || {})) {
      if (memberUserId !== currentUserId) {
        members.push({ userId: memberUserId });
      }
    }

    res.json({ success: true, members });
  } catch (err) {
    console.error("Get members error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
});
