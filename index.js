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

// ✅ Send knock (SIMPLE VERSION)
app.post("/send-knock", async (req, res) => {
  try {
    const { senderToken, receiverToken } = req.body;
    if (!senderToken || !receiverToken) {
      return res.status(400).json({ error: "senderToken and receiverToken required" });
    }

    // Get sender's IP
    const senderIp = getCompletePublicIp(req);
    
    console.log(`Knock attempt: ${senderToken.substring(0, 8)}... → ${receiverToken.substring(0, 8)}...`);
    
    // Send attempt notification to receiver
    const message = {
      token: receiverToken,
      notification: {
        title: "👀 Knock Attempt",
        body: "Someone is checking if you're home..."
      },
      data: {
        type: "knock_attempt",
        senderIp: senderIp,
        senderToken: senderToken
      },
      android: { priority: "high" }
    };

    await admin.messaging().send(message);
    console.log(`Attempt notification sent to ${receiverToken.substring(0, 8)}...`);
    
    // Store sender's IP temporarily
    await firestore.collection("knock_temp").doc(senderToken).set({
      ip: senderIp,
      timestamp: new Date().toISOString()
    });

    res.json({ 
      success: true, 
      message: "Knock attempt sent to receiver" 
    });
  } catch (err) {
    console.error("Send knock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Report IP (called by receiver's phone)
app.post("/report-ip", async (req, res) => {
  try {
    const { token, currentIp, senderToken } = req.body;
    if (!token || !currentIp || !senderToken) {
      return res.status(400).json({ error: "token, currentIp and senderToken required" });
    }

    console.log(`IP report from ${token.substring(0, 8)}...: ${currentIp}`);
    
    // Get sender's IP from temporary storage
    const senderDoc = await firestore.collection("knock_temp").doc(senderToken).get();
    
    if (!senderDoc.exists) {
      console.log("No knock attempt found for this sender");
      return res.json({ success: true, ipMatch: false });
    }

    const senderData = senderDoc.data();
    const senderIp = senderData.ip;
    
    console.log(`Comparing: Sender=${senderIp}, Receiver=${currentIp}`);
    
    // Compare IPs
    if (senderIp === currentIp) {
      // IPs match - send actual knock
      console.log("✅ IPs MATCH! Sending actual knock...");
      
      const knockMessage = {
        token: token,
        notification: {
          title: "🔔 Door Knock!",
          body: "Someone is at your door!"
        },
        data: {
          type: "actual_knock"
        },
        android: { priority: "high" }
      };

      await admin.messaging().send(knockMessage);
      
      // Clean up temp data
      await firestore.collection("knock_temp").doc(senderToken).delete();
      
      return res.json({ success: true, ipMatch: true, action: "knock_sent" });
    } else {
      // IPs don't match - do nothing
      console.log("❌ IPs DON'T match. No action taken.");
      
      // Clean up temp data
      await firestore.collection("knock_temp").doc(senderToken).delete();
      
      return res.json({ success: true, ipMatch: false, action: "no_action" });
    }
  } catch (err) {
    console.error("Report IP error:", err);
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

    console.log(`Found ${userGroups.length} groups`);
    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get group members
app.post("/group-members", async (req, res) => {
  try {
    const { groupCode, currentToken } = req.body;
    if (!groupCode) return res.status(400).json({ error: "groupCode required" });

    const groupDoc = await firestore.collection("groups").doc(groupCode.toUpperCase()).get();
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    const members = [];

    for (const [memberToken] of Object.entries(groupData.members || {})) {
      if (memberToken !== currentToken) {
        members.push({ token: memberToken });
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
