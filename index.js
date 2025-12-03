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
  console.log("Client IP detected:", completeIp);
  return completeIp;
}

// ✅ Register device helper
async function registerDevice(token) {
  try {
    await firestore.collection("devices").doc(token).set({
      token: token,
      lastActive: new Date().toISOString(),
    }, { merge: true });
    console.log(`✅ Device registered: ${token.substring(0, 10)}...`);
    return true;
  } catch (err) {
    console.error("❌ Device registration error:", err);
    return false;
  }
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
    
    // Register device first
    await registerDevice(token);
    
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

    console.log(`✅ Group created: ${groupName} (${groupCode}) - Creator IP: ${publicIp}`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("❌ Create group error:", err);
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

    // Register device first
    await registerDevice(token);

    await groupRef.update({
      [`members.${token}`]: {
        publicIp: publicIp,
        lastUpdated: new Date().toISOString()
      }
    });

    const groupData = groupDoc.data();
    console.log(`✅ Token ${token.substring(0, 10)}... joined group ${groupCode} (IP: ${publicIp})`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("❌ Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update member IP (call this when network changes)
app.post("/update-ip", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const publicIp = getCompletePublicIp(req);
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${token}.publicIp`]: publicIp,
      [`members.${token}.lastUpdated`]: new Date().toISOString()
    });

    console.log(`✅ Updated IP for ${token.substring(0, 10)}... in group ${groupCode}: ${publicIp}`);
    res.json({ success: true, publicIp });
  } catch (err) {
    console.error("❌ Update IP error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send knock (MAIN FUNCTION)
app.post("/send-knock", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const senderIp = getCompletePublicIp(req);
    console.log(`🔔 Knock attempt from ${token.substring(0, 10)}... (IP: ${senderIp}) to group ${groupCode}`);

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    
    // Check if sender is in the group
    if (!groupData.members || !groupData.members[token]) {
      console.log(`❌ Sender ${token.substring(0, 10)}... not in group`);
      return res.status(403).json({ error: "Not a group member" });
    }

    // Update sender's IP
    await groupRef.update({
      [`members.${token}.publicIp`]: senderIp,
      [`members.${token}.lastUpdated`]: new Date().toISOString()
    });

    // Find other members with same IP
    const matchingMembers = [];
    
    console.log("Checking group members:", Object.keys(groupData.members || {}));
    
    for (const [memberToken, memberData] of Object.entries(groupData.members || {})) {
      console.log(`Member ${memberToken.substring(0, 10)}... IP: ${memberData.publicIp}`);
      if (memberToken !== token && memberData.publicIp === senderIp) {
        matchingMembers.push(memberToken);
        console.log(`✅ Match found: ${memberToken.substring(0, 10)}... has same IP`);
      }
    }

    console.log(`📊 IP match check: ${senderIp} found ${matchingMembers.length} matching members`);

    if (matchingMembers.length === 0) {
      console.log(`❌ No one home on network ${senderIp}`);
      return res.status(400).json({ error: "No one home (different network)" });
    }

    // Get device documents to verify tokens exist
    const validTokens = [];
    for (const memberToken of matchingMembers) {
      const deviceDoc = await firestore.collection("devices").doc(memberToken).get();
      if (deviceDoc.exists) {
        validTokens.push(memberToken);
        console.log(`✅ Valid device: ${memberToken.substring(0, 10)}...`);
      } else {
        console.log(`⚠️ Skipping ${memberToken.substring(0, 10)}... - not in devices collection`);
      }
    }

    if (validTokens.length === 0) {
      console.log(`❌ No valid device tokens found`);
      return res.status(400).json({ error: "No valid device tokens found" });
    }

    console.log(`📤 Sending FCM to ${validTokens.length} valid tokens`);

    // Send FCM to all matching members
    const message = {
      tokens: validTokens,
      data: {
        title: "🔔 Knock Knock!",
        body: "Someone is at the door!",
        type: "knock",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
      apns: {
        payload: {
          aps: {
            alert: {
              title: "🔔 Knock Knock!",
              body: "Someone is at the door!"
            },
            sound: "default"
          }
        }
      }
    };

    console.log("FCM Message:", JSON.stringify(message, null, 2));
    
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`📨 FCM Response: Success: ${response.successCount}, Failure: ${response.failureCount}`);
    
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`❌ FCM failed for ${validTokens[idx].substring(0, 10)}...:`, resp.error);
        }
      });
    }

    if (response.successCount > 0) {
      console.log(`✅ Knock successfully delivered to ${response.successCount} device(s)`);
    }

    res.json({ 
      success: true, 
      count: validTokens.length, 
      fcmSuccess: response.successCount,
      fcmFailure: response.failureCount,
      message: "Knock delivered" 
    });
  } catch (err) {
    console.error("❌ Send knock error:", err);
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

    console.log(`📋 Found ${userGroups.length} groups for token ${token.substring(0, 10)}...`);
    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("❌ Get groups error:", err);
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
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
});
