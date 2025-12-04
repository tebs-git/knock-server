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

// ✅ Get consistent public IP address (Render-compatible)
function getCompletePublicIp(req) {
  // Render-specific: x-forwarded-for contains the REAL client IP
  // Format: "real_ip, load_balancer_ip, ..."
  let ip = req.headers['x-forwarded-for'];
  
  if (ip) {
    // Take the FIRST IP in the chain (the original client)
    const ipChain = ip.split(',').map(i => i.trim());
    const clientIp = ipChain[0];
    
    // Clean up IPv6-mapped IPv4 addresses
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    console.log(`🌐 IP from x-forwarded-for: ${cleanIp} (full chain: ${ipChain.join(' → ')})`);
    return cleanIp;
  }
  
  // Fallback - shouldn't happen on Render
  ip = req.ip || 
       req.connection.remoteAddress || 
       req.socket.remoteAddress || 
       'unknown';
  
  console.log(`⚠️  Using fallback IP: ${ip}`);
  return ip.replace(/^::ffff:/, '');
}

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Create group with IP synchronization
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) return res.status(400).json({ error: "token and groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const userIp = getCompletePublicIp(req); // Get creator's IP
    
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

    // Also store in device_status for tracking
    await firestore.collection("device_status").doc(token).set({
      public_ip: userIp,
      last_updated: new Date().toISOString()
    }, { merge: true });

    console.log(`✅ Group created: ${groupName} (${groupCode}) with creator IP: ${userIp}`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Create group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group with IP synchronization
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const userIp = getCompletePublicIp(req); // Get joiner's IP
    
    await groupRef.update({
      [`members.${token}`]: { 
        joinedAt: Date.now(),
        public_ip: userIp,
        last_ip_update: new Date().toISOString()
      }
    });

    // Also store in device_status for tracking
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

// ✅ Update IP when connecting to WiFi (SYNCHRONIZED to groups)
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

    // 2. Find ALL groups this user belongs to and update their IP there too
    const groupsSnapshot = await firestore.collection("groups").get();
    const updatePromises = [];
    let groupsUpdated = 0;

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        // Update this user's IP in the group document
        const groupRef = firestore.collection("groups").doc(doc.id);
        updatePromises.push(
          groupRef.update({
            [`members.${token}.public_ip`]: publicIp,
            [`members.${token}.last_ip_update`]: new Date().toISOString()
          })
        );
        groupsUpdated++;
        console.log(`📱 Updated IP in group ${doc.id} for ${token.substring(0, 8)}...`);
      }
    });

    await Promise.all(updatePromises);
    
    console.log(`📱 ${token.substring(0, 8)}... IP updated: ${publicIp} (synced to ${groupsUpdated} groups)`);
    res.json({ success: true, public_ip: publicIp, groups_updated: groupsUpdated });
  } catch (err) {
    console.error("Update IP error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Set IP to "n/a" when disconnecting (SYNCHRONIZED to groups)
app.post("/set-offline", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    // 1. Update device_status collection
    await firestore.collection("device_status").doc(token).set({
      public_ip: "n/a",
      last_updated: new Date().toISOString()
    }, { merge: true });

    // 2. Find ALL groups this user belongs to and set to "n/a"
    const groupsSnapshot = await firestore.collection("groups").get();
    const updatePromises = [];
    let groupsUpdated = 0;

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        const groupRef = firestore.collection("groups").doc(doc.id);
        updatePromises.push(
          groupRef.update({
            [`members.${token}.public_ip`]: "n/a",
            [`members.${token}.last_ip_update`]: new Date().toISOString()
          })
        );
        groupsUpdated++;
        console.log(`📱 Set offline in group ${doc.id} for ${token.substring(0, 8)}...`);
      }
    });

    await Promise.all(updatePromises);
    
    console.log(`📱 ${token.substring(0, 8)}... set to offline (synced to ${groupsUpdated} groups)`);
    res.json({ success: true, status: "offline", groups_updated: groupsUpdated });
  } catch (err) {
    console.error("Set offline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ SIMPLE KNOCK: Compare IPs FROM THE GROUP DOCUMENT (FIXED)
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

    // 4. Get all other members (remove sender) and check their IPs FROM GROUP DOCUMENT
    const tokensToKnock = [];
    const memberDetails = [];
    
    Object.entries(members).forEach(([memberToken, memberData]) => {
      if (memberToken !== senderToken) {
        const memberIp = memberData.public_ip || "n/a";
        
        console.log(`🔍 Member ${memberToken.substring(0, 8)}...: IP = "${memberIp}", Sender IP = "${senderIp}"`);
        memberDetails.push(`${memberToken.substring(0, 8)}...: ${memberIp}`);
        
        // Compare IPs - only knock if they match AND not "n/a"
        if (memberIp === senderIp && memberIp !== "n/a") {
          tokensToKnock.push(memberToken);
          console.log(`✅ Match! Will knock ${memberToken.substring(0, 8)}...`);
        }
      }
    });

    if (tokensToKnock.length === 0) {
      console.log(`❌ No one in group has matching IP (${senderIp})`);
      console.log(`📋 Member IPs in group: ${memberDetails.join(', ')}`);
      
      return res.status(400).json({ 
        success: false,
        error: "No one home", 
        details: {
          senderIp: senderIp,
          groupMembers: memberDetails,
          message: "No group members have matching IP. Make sure they're on same WiFi and IP is updated."
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
    console.log(`📤 Actual knock sent to ${tokensToKnock.length} member(s): ${tokensToKnock.map(t => t.substring(0, 8) + '...').join(', ')}`);
    
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

// ✅ Get group members (optional)
app.post("/group-members", async (req, res) => {
  try {
    const { groupCode } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = Object.entries(groupData.members || {}).map(([token, data]) => ({
      token: token.substring(0, 8) + '...',
      ip: data.public_ip || "unknown",
      joinedAt: data.joinedAt,
      lastIpUpdate: data.last_ip_update
    }));

    res.json({ success: true, members: members, groupName: groupData.name });
  } catch (err) {
    console.error("Get members error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ DEBUG: Check exact database state
app.post("/debug-group", async (req, res) => {
  try {
    const { groupCode, token } = req.body;
    
    console.log("🔍 DEBUG GROUP REQUEST");
    console.log("Group Code:", groupCode);
    console.log("Token:", token ? token.substring(0, 8) + "..." : "none");
    
    // Get group data
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.json({ error: "Group not found" });
    }
    
    const groupData = groupDoc.data();
    console.log("Group Name:", groupData.name);
    
    // List all members
    const members = groupData.members || {};
    console.log(`Total Members: ${Object.keys(members).length}`);
    
    Object.entries(members).forEach(([memberToken, memberData]) => {
      console.log(`👤 ${memberToken.substring(0, 8)}...:`);
      console.log(`   IP: ${memberData.public_ip || "MISSING"}`);
      console.log(`   Joined: ${new Date(memberData.joinedAt).toISOString()}`);
      console.log(`   Last IP Update: ${memberData.last_ip_update || "NEVER"}`);
    });
    
    // Also check device_status
    if (token) {
      const statusDoc = await firestore.collection("device_status").doc(token).get();
      if (statusDoc.exists) {
        const statusData = statusDoc.data();
        console.log(`📱 Device Status for ${token.substring(0, 8)}...:`);
        console.log(`   IP: ${statusData.public_ip || "MISSING"}`);
        console.log(`   Last Updated: ${statusData.last_updated || "NEVER"}`);
      }
    }
    
    res.json({ 
      success: true, 
      group: groupData,
      message: "Check server logs for details"
    });
    
  } catch (err) {
    console.error("Debug error:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
  console.log(`🔧 IP synchronization: ON (IPs stored in both device_status and groups)`);
});

