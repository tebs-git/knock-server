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
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: { [token]: { joinedAt: Date.now() } }
    });

    console.log(`Group created: ${groupName} (${groupCode})`);
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

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${token}`]: { joinedAt: Date.now() }
    });

    const groupData = groupDoc.data();
    console.log(`User joined group ${groupCode}`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update IP when connecting to WiFi
app.post("/update-ip", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const publicIp = getCompletePublicIp(req);
    
    await firestore.collection("device_status").doc(token).set({
      public_ip: publicIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    console.log(`📱 ${token.substring(0, 8)}... IP updated: ${publicIp}`);
    res.json({ success: true, public_ip: publicIp });
  } catch (err) {
    console.error("Update IP error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Set IP to "n/a" when disconnecting
app.post("/set-offline", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    await firestore.collection("device_status").doc(token).set({
      public_ip: "n/a",
      last_updated: new Date().toISOString()
    }, { merge: true });

    console.log(`📱 ${token.substring(0, 8)}... set to offline (n/a)`);
    res.json({ success: true, status: "offline" });
  } catch (err) {
    console.error("Set offline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ SIMPLE KNOCK: Compare stored IPs, send if match
app.post("/knock", async (req, res) => {
  try {
    const { senderToken, groupCode } = req.body;
    if (!senderToken || !groupCode) {
      return res.status(400).json({ error: "senderToken and groupCode required" });
    }

    // 1. Get sender's current IP
    const senderIp = getCompletePublicIp(req);
    console.log(`👊 Knock from ${senderToken.substring(0, 8)}... (IP: ${senderIp}) to group ${groupCode}`);
    
    // 2. Get the group
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    const allMembers = Object.keys(groupData.members || {});
    
    // 3. Remove sender from list (don't knock yourself)
    const receivers = allMembers.filter(token => token !== senderToken);
    
    if (receivers.length === 0) {
      return res.status(400).json({ error: "No other members in group" });
    }

    console.log(`📋 Checking ${receivers.length} member(s) in group`);
    
    // 4. For each receiver, check their stored IP
    const tokensToKnock = [];
    
    for (const receiverToken of receivers) {
      // Get receiver's stored IP from device_status collection
      const statusDoc = await firestore.collection("device_status").doc(receiverToken).get();
      
      if (statusDoc.exists) {
        const receiverData = statusDoc.data();
        const receiverIp = receiverData.public_ip;
        
        console.log(`🔍 ${receiverToken.substring(0, 8)}...: stored IP = ${receiverIp}, sender IP = ${senderIp}`);
        
        // Compare IPs - only knock if they match AND not "n/a"
        if (receiverIp === senderIp && receiverIp !== "n/a") {
          tokensToKnock.push(receiverToken);
          console.log(`✅ Match! Will knock ${receiverToken.substring(0, 8)}...`);
        }
      }
    }

    if (tokensToKnock.length === 0) {
      console.log(`❌ No one in group has matching IP (${senderIp})`);
      return res.status(400).json({ error: "No one home" });
    }

    // 5. Send actual knock to matched members
    const promises = tokensToKnock.map(receiverToken => {
      const message = {
        token: receiverToken,
        notification: {
          title: "🔔 Door Knock!",
          body: "Someone is at your door!"
        },
        android: { priority: "high" }
      };
      return admin.messaging().send(message);
    });

    await Promise.all(promises);
    console.log(`📤 Actual knock sent to ${tokensToKnock.length} member(s)`);
    
    res.json({ 
      success: true, 
      message: `Knock delivered to ${tokensToKnock.length} person(s) at home`,
      count: tokensToKnock.length
    });

  } catch (err) {
    console.error("❌ Knock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get user's groups (optional - for UI)
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

    console.log(`Found ${userGroups.length} groups for user`);
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
