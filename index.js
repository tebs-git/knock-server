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

// ✅ Register device (optional - can be called from app)
app.post("/register", async (req, res) => {
  try {
    const { token, name } = req.body;
    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    await firestore.collection("devices").doc(token).set({
      token: token,
      name: name || "Unknown Device",
      lastActive: new Date().toISOString(),
    });

    console.log(`Registered device with token: ${token.substring(0, 10)}...`);
    res.json({ success: true });
  } catch (err) {
    console.error("Error registering device:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create WiFi group
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName, ipPrefix } = req.body;
    if (!token || !groupName) {
      return res.status(400).json({ error: "token and groupName are required" });
    }

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const groupData = {
      name: groupName,
      code: groupCode,
      createdBy: token,
      createdAt: Date.now(),
      ipPrefix: ipPrefix || null,
      members: {
        [token]: {
          joinedAt: Date.now(),
          ipPrefix: ipPrefix || null
        }
      }
    };

    await firestore.collection("groups").doc(groupCode).set(groupData);

    console.log(`Group created: ${groupName} (${groupCode}) by ${token.substring(0, 10)}...`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Error creating group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode, ipPrefix } = req.body;
    if (!token || !groupCode) {
      return res.status(400).json({ error: "token and groupCode are required" });
    }

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    await groupRef.update({
      [`members.${token}`]: {
        joinedAt: Date.now(),
        ipPrefix: ipPrefix || null
      }
    });

    const groupData = groupDoc.data();
    console.log(`Token ${token.substring(0, 10)}... joined group ${groupCode}`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Error joining group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send knock to group
app.post("/broadcast-to-group", async (req, res) => {
  try {
    const { token, groupCode, senderIpPrefix } = req.body;
    if (!token || !groupCode) {
      return res.status(400).json({ error: "token and groupCode are required" });
    }

    const groupDoc = await firestore.collection("groups").doc(groupCode.toUpperCase()).get();
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    
    // Check if sender is member
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a group member" });
    }

    // Check WiFi network
    if (groupData.ipPrefix && senderIpPrefix && groupData.ipPrefix !== senderIpPrefix) {
      return res.status(403).json({ error: "Must be on same WiFi network" });
    }

    // Get member tokens (excluding sender)
    const tokens = [];
    for (const [memberToken, memberInfo] of Object.entries(groupData.members)) {
      if (memberToken !== token) {
        // Verify token exists in devices collection
        const deviceDoc = await firestore.collection("devices").doc(memberToken).get();
        if (deviceDoc.exists && deviceDoc.data().token) {
          tokens.push(deviceDoc.data().token);
        }
      }
    }

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other group members" });
    }

    // Send notifications
    const message = {
      tokens,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock"
      },
      android: { priority: "high" },
    };

    await admin.messaging().sendEachForMulticast(message);
    console.log(`Knock sent from ${token.substring(0, 10)}... to ${tokens.length} members`);
    res.json({ success: true, count: tokens.length });
  } catch (err) {
    console.error("Error sending knock:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get user's groups
app.post("/my-groups", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    console.log(`Looking for groups for token: ${token.substring(0, 10)}...`);
    
    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        console.log(`Found token in group ${doc.id}`);
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          createdBy: groupData.createdBy,
          memberCount: Object.keys(groupData.members).length,
          ipPrefix: groupData.ipPrefix,
          isAdmin: groupData.createdBy === token,
          joinedAt: groupData.members[token].joinedAt
        });
      }
    });

    // Sort by joinedAt timestamp (newest first)
    userGroups.sort((a, b) => b.joinedAt - a.joinedAt);

    console.log(`Found ${userGroups.length} groups for token`);
    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Error getting user groups:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/", (req, res) => {
  res.json({ status: "OK", message: "Knock Knock server running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚪 Server running on port ${PORT}`));
