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
    console.log(`Token ${token.substring(0, 10)}... joined group ${groupCode}`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ NEW: Initiate knock (Phase 1)
app.post("/initiate-knock", async (req, res) => {
  try {
    const { senderToken, receiverToken, knockId } = req.body;
    if (!senderToken || !receiverToken || !knockId) {
      return res.status(400).json({ error: "senderToken, receiverToken and knockId required" });
    }

    const senderIp = getCompletePublicIp(req);
    console.log(`🔍 Knock attempt: ${senderToken.substring(0, 10)}... → ${receiverToken.substring(0, 10)}... (KnockID: ${knockId})`);

    // Store knock attempt in database
    await firestore.collection("knock_attempts").doc(knockId).set({
      senderToken: senderToken,
      receiverToken: receiverToken,
      senderIp: senderIp,
      status: "pending",
      createdAt: new Date().toISOString()
    });

    // Send "attempt" notification to receiver
    const attemptMessage = {
      token: receiverToken,
      notification: {
        title: "🔍 Knock Attempt",
        body: "Someone is trying to knock on your door..."
      },
      data: {
        type: "knock_attempt",
        knockId: knockId,
        senderToken: senderToken,
        timestamp: new Date().toISOString()
      },
      android: { priority: "high" }
    };

    await admin.messaging().send(attemptMessage);
    console.log(`📤 Sent attempt notification to ${receiverToken.substring(0, 10)}...`);

    // Set timeout for response (30 seconds)
    setTimeout(async () => {
      const attemptDoc = await firestore.collection("knock_attempts").doc(knockId).get();
      if (attemptDoc.exists && attemptDoc.data().status === "pending") {
        await firestore.collection("knock_attempts").doc(knockId).update({
          status: "timeout",
          updatedAt: new Date().toISOString()
        });
        console.log(`⏰ Knock ${knockId} timed out (no response from receiver)`);
      }
    }, 30000);

    res.json({ 
      success: true, 
      message: "Knock attempt sent",
      knockId: knockId
    });
  } catch (err) {
    console.error("Initiate knock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ NEW: Verify presence (Phase 2 - Receiver responds)
app.post("/verify-presence", async (req, res) => {
  try {
    const { receiverToken, knockId } = req.body;
    if (!receiverToken || !knockId) {
      return res.status(400).json({ error: "receiverToken and knockId required" });
    }

    const receiverIp = getCompletePublicIp(req);
    console.log(`📡 Presence verification: ${receiverToken.substring(0, 10)}... (IP: ${receiverIp}, KnockID: ${knockId})`);

    // Get the knock attempt
    const attemptRef = firestore.collection("knock_attempts").doc(knockId);
    const attemptDoc = await attemptRef.get();
    
    if (!attemptDoc.exists) {
      return res.status(404).json({ error: "Knock attempt not found" });
    }

    const attemptData = attemptDoc.data();
    
    if (attemptData.status !== "pending") {
      return res.status(400).json({ error: "Knock attempt already processed" });
    }

    if (attemptData.receiverToken !== receiverToken) {
      return res.status(403).json({ error: "Token mismatch" });
    }

    const senderIp = attemptData.senderIp;
    const senderToken = attemptData.senderToken;

    console.log(`🔍 IP Comparison: Sender=${senderIp}, Receiver=${receiverIp}`);

    let finalStatus = "";
    let notificationTitle = "";
    let notificationBody = "";

    if (senderIp === receiverIp) {
      // ✅ IPs match - Send actual knock notification
      finalStatus = "success";
      notificationTitle = "🔔 Door Knock!";
      notificationBody = "Someone is at your door!";
      
      console.log(`✅ IPs match! Sending knock to ${receiverToken.substring(0, 10)}...`);
      
      // Send knock notification
      const knockMessage = {
        token: receiverToken,
        notification: {
          title: notificationTitle,
          body: notificationBody
        },
        data: {
          type: "knock",
          knockId: knockId,
          senderToken: senderToken,
          timestamp: new Date().toISOString()
        },
        android: { priority: "high" }
      };

      await admin.messaging().send(knockMessage);
      
      // Also notify sender that knock was successful
      const senderSuccessMessage = {
        token: senderToken,
        notification: {
          title: "✅ Knock Delivered!",
          body: "Your knock was delivered successfully"
        },
        data: {
          type: "knock_result",
          result: "success",
          knockId: knockId,
          timestamp: new Date().toISOString()
        },
        android: { priority: "high" }
      };
      
      await admin.messaging().send(senderSuccessMessage);
      
    } else {
      // ❌ IPs don't match - Notify sender
      finalStatus = "failed";
      notificationTitle = "❌ Not Nearby";
      notificationBody = "The person is not at home";
      
      console.log(`❌ IPs don't match. Notifying sender ${senderToken.substring(0, 10)}...`);
      
      // Notify sender that receiver is not home
      const senderFailMessage = {
        token: senderToken,
        notification: {
          title: "❌ Not Home",
          body: "The person is not at home right now"
        },
        data: {
          type: "knock_result",
          result: "failed",
          knockId: knockId,
          timestamp: new Date().toISOString()
        },
        android: { priority: "high" }
      };
      
      await admin.messaging().send(senderFailMessage);
      
      // Also update receiver with "not home" notification
      const receiverFailMessage = {
        token: receiverToken,
        notification: {
          title: "❌ Not Nearby",
          body: "Someone tried to knock but you're not at home"
        },
        data: {
          type: "knock_result",
          result: "failed",
          knockId: knockId,
          timestamp: new Date().toISOString()
        },
        android: { priority: "high" }
      };
      
      await admin.messaging().send(receiverFailMessage);
    }

    // Update knock attempt status
    await attemptRef.update({
      status: finalStatus,
      receiverIp: receiverIp,
      updatedAt: new Date().toISOString(),
      ipMatch: (senderIp === receiverIp)
    });

    res.json({ 
      success: true, 
      status: finalStatus,
      ipMatch: (senderIp === receiverIp),
      senderIp: senderIp,
      receiverIp: receiverIp
    });
  } catch (err) {
    console.error("Verify presence error:", err);
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
