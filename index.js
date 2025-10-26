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

// ✅ Register a device
app.post("/register", async (req, res) => {
  try {
    const { deviceId, token, name } = req.body;
    if (!deviceId || !token) {
      return res.status(400).json({ error: "deviceId and token are required" });
    }

    await firestore.collection("devices").doc(deviceId).set({
      token,
      name: name || "Unknown Device",
      lastActive: new Date().toISOString(),
    });

    console.log(`Registered device: ${deviceId}`);
    res.json({ success: true, message: `Device ${deviceId} registered` });
  } catch (err) {
    console.error("Error registering device:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Create a group
app.post("/create-group", async (req, res) => {
  try {
    const { groupId, adminDeviceId, groupName } = req.body;
    if (!groupId || !adminDeviceId || !groupName) {
      return res.status(400).json({ error: "groupId, adminDeviceId and groupName are required" });
    }

    await firestore.collection("groups").doc(groupId).set({
      adminDeviceId,
      groupName,
      members: [adminDeviceId],
      createdAt: new Date().toISOString(),
    });

    console.log(`Group created: ${groupName} (${groupId}) by ${adminDeviceId}`);
    res.json({ success: true, groupId, groupName, message: "Group created" });
  } catch (err) {
    console.error("Error creating group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join a group
app.post("/join-group", async (req, res) => {
  try {
    const { groupId, deviceId } = req.body;
    if (!groupId || !deviceId) {
      return res.status(400).json({ error: "groupId and deviceId are required" });
    }

    const groupRef = firestore.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    await groupRef.update({
      members: admin.firestore.FieldValue.arrayUnion(deviceId)
    });

    console.log(`Device ${deviceId} joined group ${groupId}`);
    res.json({ success: true, message: "Joined group" });
  } catch (err) {
    console.error("Error joining group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get user's groups
app.post("/my-groups", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId is required" });
    }

    const groupsSnapshot = await firestore.collection("groups")
      .where("members", "array-contains", deviceId)
      .get();

    const groups = [];
    groupsSnapshot.forEach(doc => {
      const data = doc.data();
      groups.push({
        groupId: doc.id,
        groupName: data.groupName,
        adminDeviceId: data.adminDeviceId,
        memberCount: data.members.length,
        isAdmin: data.adminDeviceId === deviceId
      });
    });

    res.json({ success: true, groups });
  } catch (err) {
    console.error("Error getting groups:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Broadcast to group only
app.post("/broadcast-to-group", async (req, res) => {
  try {
    const { senderId, groupId } = req.body;
    if (!senderId || !groupId) {
      return res.status(400).json({ error: "senderId and groupId are required" });
    }

    // Get group members
    const groupDoc = await firestore.collection("groups").doc(groupId).get();
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    if (!groupData.members.includes(senderId)) {
      return res.status(403).json({ error: "Not a group member" });
    }

    // Get tokens for group members only (excluding sender)
    const tokens = [];
    const memberNames = [];
    
    for (const memberId of groupData.members) {
      if (memberId !== senderId) {
        const deviceDoc = await firestore.collection("devices").doc(memberId).get();
        if (deviceDoc.exists && deviceDoc.data().token) {
          tokens.push(deviceDoc.data().token);
          memberNames.push(deviceDoc.data().name || "Unknown Device");
        }
      }
    }

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other group members" });
    }

    const message = {
      tokens,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
        groupName: groupData.groupName,
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`Broadcast sent to ${tokens.length} group members from ${senderId}`);
    
    res.json({ 
      success: true, 
      count: tokens.length, 
      groupName: groupData.groupName,
      members: memberNames,
      response 
    });
  } catch (err) {
    console.error("Error broadcasting to group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/", (req, res) => res.json({ status: "OK", message: "Knock Knock server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
