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
  // Try different headers that might contain the real public IP
  const ip = req.headers['x-forwarded-for'] || 
              req.headers['x-real-ip'] || 
              req.connection.remoteAddress || 
              req.socket.remoteAddress ||
              req.ip ||
              'unknown';
  
  console.log("Raw IP info:", {
    'x-forwarded-for': req.headers['x-forwarded-for'],
    'x-real-ip': req.headers['x-real-ip'],
    'connection.remoteAddress': req.connection.remoteAddress,
    'socket.remoteAddress': req.socket.remoteAddress,
    'req.ip': req.ip
  });
  
  // Extract the first IP if it's a list (common with x-forwarded-for)
  let completeIp = ip;
  if (ip.includes(',')) {
    completeIp = ip.split(',')[0].trim();
  }
  
  // Clean IPv6-mapped IPv4 addresses
  completeIp = completeIp.replace(/^::ffff:/, '');
  
  console.log("Final complete IP:", completeIp);
  return completeIp;
}

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Register device and report status
app.post("/register", async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) return res.status(400).json({ error: "token and userId required" });

    const publicIp = getCompletePublicIp(req);
    
    // Store in device_status collection
    await firestore.collection("device_status").doc(userId).set({
      fcm_token: token,
      public_ip: publicIp,
      last_seen: new Date().toISOString(),
    });

    console.log(`Registered: ${userId} (COMPLETE IP: ${publicIp})`);
    res.json({ success: true, public_ip: publicIp });
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

    const publicIp = getCompletePublicIp(req);
    
    await firestore.collection("device_status").doc(userId).set({
      fcm_token: token,
      public_ip: publicIp,
      last_seen: new Date().toISOString(),
    }, { merge: true });

    console.log(`Status updated: ${userId} -> COMPLETE IP: ${publicIp}`);
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

    const senderIp = getCompletePublicIp(req);
    
    // Get receiver's status
    const receiverDoc = await firestore.collection("device_status").doc(receiverUserId).get();
    if (!receiverDoc.exists) return res.status(404).json({ error: "Receiver not found" });

    const receiverData = receiverDoc.data();
    const receiverIp = receiverData.public_ip;
    const receiverToken = receiverData.fcm_token;

    console.log(`IP Comparison: Sender=${senderIp}, Receiver=${receiverIp}`);

    if (!receiverToken) return res.status(404).json({ error: "Receiver token not available" });

    // Proximity check - compare COMPLETE IPs
    if (senderIp === receiverIp) {
      // Send FCM notification
      await admin.messaging().send({
        token: receiverToken,
        data: { type: "knock", timestamp: new Date().toISOString(), senderId: senderUserId },
        android: { priority: "high" },
      });

      console.log(`✅ Knock delivered: ${senderUserId} -> ${receiverUserId} (Same network: ${senderIp})`);
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

// ✅ Get group members (FIXED VERSION)
app.post("/group-members", async (req, res) => {
  try {
    const { groupCode, currentUserId } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const groupDoc = await firestore.collection("groups").doc(groupCode.toUpperCase()).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = [];

    if (groupData.members) {
      for (const [memberUserId, memberInfo] of Object.entries(groupData.members)) {
        if (memberUserId !== currentUserId) {
          members.push({ 
            userId: memberUserId,
            joinedAt: memberInfo.joinedAt || Date.now()
          });
        }
      }
    }

    console.log(`Found ${members.length} members in group ${groupCode} (excluding ${currentUserId})`);
    res.json({ success: true, members: members });
  } catch (err) {
    console.error("Get members error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "Knock Knock server running",
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
});

