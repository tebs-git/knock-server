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
          public_ip: userIp,
          last_ip_update: new Date().toISOString()
        } 
      }
    });

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
    
    await firestore.collection("device_status").doc(token).set({
      public_ip: publicIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

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

// ✅ Set device to offline
app.post("/set-offline", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    await firestore.collection("device_status").doc(token).set({
      public_ip: "n/a",
      last_updated: new Date().toISOString()
    }, { merge: true });

    console.log(`📱 ${token.substring(0, 8)}... marked offline`);
    
    res.json({ 
      success: true, 
      status: "offline"
    });
  } catch (err) {
    console.error("Set offline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ SIMPLE KNOCK: With FULL DEBUG LOGGING
app.post("/knock", async (req, res) => {
  try {
    const { senderToken, groupCode } = req.body;
    if (!senderToken || !groupCode) {
      return res.status(400).json({ error: "senderToken and groupCode required" });
    }

    console.log("\n" + "=".repeat(80));
    console.log("🚪 KNOCK REQUEST RECEIVED");
    console.log("=".repeat(80));
    
    // 1. Get sender's current IP
    const senderIp = getCompletePublicIp(req);
    console.log(`📱 SENDER: ${senderToken.substring(0, 8)}...`);
    console.log(`🌐 SENDER IP: ${senderIp}`);
    console.log(`🏷️  GROUP CODE: ${groupCode}`);
    
    // 2. Get the group document
    const groupDocId = groupCode.toUpperCase();
    console.log(`🔍 LOOKING FOR GROUP DOCUMENT: groups/${groupDocId}`);
    
    const groupRef = firestore.collection("groups").doc(groupDocId);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      console.log(`❌ GROUP NOT FOUND: No document at groups/${groupDocId}`);
      console.log("=".repeat(80) + "\n");
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    const members = groupData.members || {};
    
    console.log(`✅ GROUP FOUND: "${groupData.name}"`);
    console.log(`👥 TOTAL MEMBERS: ${Object.keys(members).length}`);
    
    // 3. Check if sender is in this group
    if (!members[senderToken]) {
      console.log(`❌ SENDER NOT IN GROUP: ${senderToken.substring(0, 8)}... not found in group members`);
      console.log("=".repeat(80) + "\n");
      return res.status(403).json({ error: "You are not a member of this group" });
    }

    console.log(`✅ SENDER IS IN GROUP`);
    
    // 4. SHOW ALL MEMBERS WITH THEIR IPs
    console.log("\n📋 GROUP MEMBERS DETAIL:");
    console.log("-".repeat(40));
    
    const tokensToKnock = [];
    let senderFound = false;
    
    Object.entries(members).forEach(([memberToken, memberData], index) => {
      const memberIp = memberData.public_ip || "MISSING";
      const isSender = memberToken === senderToken;
      
      if (isSender) {
        senderFound = true;
        console.log(`${index + 1}. 👤 ${memberToken.substring(0, 8)}... [SENDER]`);
      } else {
        console.log(`${index + 1}. 👤 ${memberToken.substring(0, 8)}...`);
      }
      
      console.log(`   📍 IP: ${memberIp}`);
      console.log(`   📅 Joined: ${new Date(memberData.joinedAt).toISOString()}`);
      console.log(`   🔄 Last IP Update: ${memberData.last_ip_update || "NEVER"}`);
      console.log(`   🎯 Compare: "${memberIp}" === "${senderIp}" ? ${memberIp === senderIp ? "✅ MATCH" : "❌ NO MATCH"}`);
      console.log("");
      
      if (!isSender && memberIp === senderIp) {
        tokensToKnock.push(memberToken);
      }
    });

    if (!senderFound) {
      console.log(`⚠️  WARNING: Sender token not found in iteration but was found earlier`);
    }

    console.log("\n🎯 KNOCK DECISION:");
    console.log("-".repeat(40));
    
    if (tokensToKnock.length === 0) {
      console.log(`❌ NO MATCHES FOUND`);
      console.log(`   Sender IP: ${senderIp}`);
      console.log(`   No other members have matching IP`);
      console.log("=".repeat(80) + "\n");
      
      return res.status(400).json({ 
        success: false,
        error: "No one home",
        details: {
          senderIp: senderIp,
          groupCode: groupCode,
          totalMembers: Object.keys(members).length,
          message: "No group members have matching IP."
        }
      });
    }

    console.log(`✅ FOUND ${tokensToKnock.length} MATCH(ES):`);
    tokensToKnock.forEach((token, index) => {
      console.log(`   ${index + 1}. ${token.substring(0, 8)}...`);
    });

    // 5. Send actual knock to matched members
    console.log("\n📤 SENDING KNOCK NOTIFICATIONS:");
    console.log("-".repeat(40));
    
    const promises = tokensToKnock.map(receiverToken => {
      const message = {
        token: receiverToken,
        notification: {
          title: "🔔 Door Knock!",
          body: "Someone is at your door!"
        },
        android: { priority: "high" }
      };
      console.log(`   📲 Sending to: ${receiverToken.substring(0, 8)}...`);
      return admin.messaging().send(message);
    });

    await Promise.all(promises);
    console.log(`\n✅ SUCCESS: Knock sent to ${tokensToKnock.length} member(s)`);
    console.log("=".repeat(80) + "\n");
    
    res.json({ 
      success: true, 
      message: `Knock delivered to ${tokensToKnock.length} person(s) at home`,
      count: tokensToKnock.length
    });

  } catch (err) {
    console.error("\n❌ KNOCK ERROR:", err.message);
    console.error(err.stack);
    console.log("=".repeat(80) + "\n");
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

// ✅ Debug endpoint to check ANY group
app.post("/debug-group", async (req, res) => {
  try {
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    console.log("\n" + "=".repeat(80));
    console.log("🔍 DEBUG GROUP REQUEST");
    console.log("=".repeat(80));
    
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      console.log(`❌ GROUP NOT FOUND: groups/${groupCode.toUpperCase()}`);
      console.log("=".repeat(80) + "\n");
      return res.json({ error: "Group not found" });
    }
    
    const groupData = groupDoc.data();
    
    console.log(`✅ GROUP: "${groupData.name}" (${groupDoc.id})`);
    console.log(`📅 Created: ${new Date(groupData.createdAt).toISOString()}`);
    console.log(`👥 Members: ${Object.keys(groupData.members || {}).length}`);
    
    console.log("\n📋 MEMBER DETAILS:");
    console.log("-".repeat(40));
    
    Object.entries(groupData.members || {}).forEach(([token, data], index) => {
      console.log(`${index + 1}. 👤 ${token.substring(0, 8)}...`);
      console.log(`   📍 IP: ${data.public_ip || "MISSING"}`);
      console.log(`   📅 Joined: ${new Date(data.joinedAt).toISOString()}`);
      console.log(`   🔄 Last IP Update: ${data.last_ip_update || "NEVER"}`);
      console.log("");
    });
    
    console.log("=".repeat(80) + "\n");
    
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
  console.log(`📝 DEBUG MODE: Full group details will be logged`);
});
