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
  // Render-specific: x-forwarded-for contains the REAL client IP
  let ip = req.headers['x-forwarded-for'];
  
  if (ip) {
    // Take the FIRST IP in the chain (the original client)
    const ipChain = ip.split(',').map(i => i.trim());
    const clientIp = ipChain[0];
    
    // Clean up IPv6-mapped IPv4 addresses
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    return cleanIp;
  }
  
  // Fallback
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
          public_ip: userIp,
          last_ip_update: new Date().toISOString()
        } 
      }
    });

    // Also store in device_status
    await firestore.collection("device_status").doc(token).set({
      public_ip: userIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    console.log(`✅ Group created: ${groupName} (${groupCode}) with IP: ${userIp}`);
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
        public_ip: userIp,
        last_ip_update: new Date().toISOString()
      }
    });

    // Also store in device_status
    await firestore.collection("device_status").doc(token).set({
      public_ip: userIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    const groupData = groupDoc.data();
    console.log(`✅ User joined group ${groupCode} with IP: ${userIp}`);
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
            [`members.${token}.public_ip`]: publicIp,
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

// ✅ Set device to offline - ONLY update device_status, NOT groups
app.post("/set-offline", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    // ONLY update device_status collection
    await firestore.collection("device_status").doc(token).set({
      public_ip: "n/a",
      last_updated: new Date().toISOString()
    }, { merge: true });

    // DO NOT update group documents - leave IPs as they are!
    console.log(`📱 ${token.substring(0, 8)}... marked offline (group IPs preserved)`);
    
    res.json({ 
      success: true, 
      status: "offline"
    });
  } catch (err) {
    console.error("Set offline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ SIMPLE KNOCK: Compare IPs FROM GROUP DOCUMENT
app.post("/knock", async (req, res) => {
  try {
    const { senderToken, groupCode } = req.body;
    if (!senderToken || !groupCode) {
      return res.status(400).json({ error: "senderToken and groupCode required" });
    }

    // 1. Get sender's current IP
    const senderIp = getCompletePublicIp(req);
    console.log(`👊 Knock from ${senderToken.substring(0, 8)}... (IP: ${senderIp}) to group ${groupCode}`);
    
    // 2. Get the group document
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    const members = groupData.members || {};
    
    // 3. Check if sender is in this group
    if (!members[senderToken]) {
      return res.status(403).json({ error: "You are not a member of this group" });
    }

    // 4. Get all other members (remove sender)
    const tokensToKnock = [];
    const memberDetails = [];
    
    Object.entries(members).forEach(([memberToken, memberData]) => {
      if (memberToken !== senderToken) {
        const memberIp = memberData.public_ip || "n/a";
        
        console.log(`🔍 Member ${memberToken.substring(0, 8)}...: IP = "${memberIp}", Sender IP = "${senderIp}"`);
        memberDetails.push(`${memberToken.substring(0, 8)}...: ${memberIp}`);
        
        // CRITICAL: Just compare IPs - no "n/a" check
        if (memberIp === senderIp) {
          tokensToKnock.push(memberToken);
          console.log(`✅ Match! Will knock ${memberToken.substring(0, 8)}...`);
        }
      }
    });

    if (tokensToKnock.length === 0) {
      console.log(`❌ No one in group has matching IP (${senderIp})`);
      console.log(`📋 Member IPs: ${memberDetails.join(', ')}`);
      
      return res.status(400).json({ 
        success: false,
        error: "No one home",
        details: {
          senderIp: senderIp,
          groupMembers: memberDetails
        }
      });
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
    console.log(`📤 Knock sent to ${tokensToKnock.length} member(s)`);
    
    res.json({ 
      success: true, 
      message: `Knock delivered to ${tokensToKnock.length} person(s) at home`,
      count: tokensToKnock.length
    });

  } catch (err) {
    console.error("❌ Knock error:", err);
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
          yourIp: groupData.members[token].public_ip || "unknown"
        });
      }
    });

    console.log(`Found ${userGroups.length} groups for user ${token.substring(0, 8)}...`);
    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Debug endpoint
app.post("/debug-group", async (req, res) => {
  try {
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.json({ error: "Group not found" });
    }
    
    const groupData = groupDoc.data();
    
    console.log(`🔍 DEBUG Group: ${groupCode}`);
    console.log(`Name: ${groupData.name}`);
    console.log(`Members: ${Object.keys(groupData.members || {}).length}`);
    
    Object.entries(groupData.members || {}).forEach(([token, data]) => {
      console.log(`  ${token.substring(0, 8)}...: IP = ${data.public_ip || "MISSING"}`);
    });
    
    res.json({ 
      success: true, 
      group: groupData
    });
    
  } catch (err) {
    console.error("Debug error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
  console.log(`✅ IPs are preserved in groups (not set to "n/a")`);
});
