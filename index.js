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

// ✅ Get consistent public IP address
function getCompletePublicIp(req) {
  let ip = req.headers['x-forwarded-for'];
  
  if (ip) {
    const ipChain = ip.split(',').map(i => i.trim());
    const clientIp = ipChain[0];
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    return cleanIp;
  }
  
  ip = req.ip || 
       req.connection.remoteAddress || 
       req.socket.remoteAddress || 
       'unknown';
  
  return ip.replace(/^::ffff:/, '');
}

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Create group with IP
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) return res.status(400).json({ error: "token and groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const userIp = getCompletePublicIp(req);
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: { 
        [token]: { 
          joinedAt: Date.now(),
          publicIp: userIp,
          last_ip_update: new Date().toISOString()
        } 
      }
    });

    await firestore.collection("device_status").doc(token).set({
      public_ip: userIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    console.log(`Group created: ${groupName} (${groupCode})`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Create group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group with IP
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const userIp = getCompletePublicIp(req);
    
    await groupRef.update({
      [`members.${token}`]: { 
        joinedAt: Date.now(),
        publicIp: userIp,
        last_ip_update: new Date().toISOString()
      }
    });

    await firestore.collection("device_status").doc(token).set({
      public_ip: userIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    const groupData = groupDoc.data();
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update IP when connecting to WiFi (Called by Android NetworkMonitor)
app.post("/update-ip", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const publicIp = getCompletePublicIp(req);
    
    // 1. Update device_status collection
    await firestore.collection("device_status").doc(token).set({
      public_ip: publicIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    // 2. Update IP in ALL groups this user belongs to
    const groupsSnapshot = await firestore.collection("groups").get();
    const updatePromises = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        const groupRef = firestore.collection("groups").doc(doc.id);
        updatePromises.push(
          groupRef.update({
            [`members.${token}.publicIp`]: publicIp,
            [`members.${token}.last_ip_update`]: new Date().toISOString()
          })
        );
      }
    });

    await Promise.all(updatePromises);
    
    console.log(`📱 ${token.substring(0, 8)}... IP updated: ${publicIp}`);
    res.json({ success: true, public_ip: publicIp });
  } catch (err) {
    console.error("Update IP error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Set device to offline/n/a when disconnecting from WiFi (Called by Android NetworkMonitor)
app.post("/set-offline", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    // Update device_status collection
    await firestore.collection("device_status").doc(token).set({
      public_ip: "n/a",
      last_updated: new Date().toISOString()
    }, { merge: true });

    // Set IP to "n/a" in ALL groups this user belongs to
    const groupsSnapshot = await firestore.collection("groups").get();
    const updatePromises = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        const groupRef = firestore.collection("groups").doc(doc.id);
        updatePromises.push(
          groupRef.update({
            [`members.${token}.publicIp`]: "n/a",
            [`members.${token}.last_ip_update`]: new Date().toISOString()
          })
        );
      }
    });

    await Promise.all(updatePromises);
    
    console.log(`📱 ${token.substring(0, 8)}... set to offline/n/a`);
    res.json({ 
      success: true, 
      status: "offline"
    });
  } catch (err) {
    console.error("Set offline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ SIMPLE KNOCK: Compare IPs from group document
app.post("/knock", async (req, res) => {
  try {
    const { senderToken, groupCode } = req.body;
    if (!senderToken || !groupCode) {
      return res.status(400).json({ error: "senderToken and groupCode required" });
    }

    const senderIp = getCompletePublicIp(req);
    
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    const members = groupData.members || {};
    
    if (!members[senderToken]) {
      return res.status(403).json({ error: "You are not a member of this group" });
    }

    const tokensToKnock = [];
    
    Object.entries(members).forEach(([memberToken, memberData]) => {
      if (memberToken !== senderToken) {
        const memberIp = memberData.publicIp || "n/a";
        
        // Only send knock if:
        // 1. IPs match exactly
        // 2. Member IP is not "n/a" (meaning they're on WiFi)
        if (memberIp === senderIp && memberIp !== "n/a") {
          tokensToKnock.push(memberToken);
        }
      }
    });

    if (tokensToKnock.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: "No one home"
      });
    }

    const promises = tokensToKnock.map(receiverToken => {
      const message = {
        token: receiverToken,
        notification: {
          title: "🔔 Door Knock!",
          body: "Someone is at your door!"
        },
        android: { 
          priority: "high",
          notification: {
            sound: "default", // Ensures sound plays on Android
            channel_id: "knock_channel"
          }
        },
        apns: {
          payload: {
            aps: {
              sound: "knock.caf", // For iOS
              contentAvailable: true
            }
          }
        }
      };
      return admin.messaging().send(message);
    });

    await Promise.all(promises);
    
    console.log(`📤 Knock sent to ${tokensToKnock.length} device(s) at IP: ${senderIp}`);
    
    res.json({ 
      success: true, 
      message: `Knock delivered to ${tokensToKnock.length} person(s) at home`,
      count: tokensToKnock.length
    });

  } catch (err) {
    console.error("Knock error:", err);
    res.status(500).json({ success: false, error: err.message });
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
          yourIp: groupData.members[token].publicIp || "unknown"
        });
      }
    });

    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
  console.log(`📱 WiFi detection: ON (IP stored when on WiFi, n/a when disconnected)`);
  console.log(`🔔 Knock logic: Send only if IPs match AND receiver is on WiFi (not n/a)`);
});
