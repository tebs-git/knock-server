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

// ✅ Create or update a group (one group per device)
app.post("/create-or-update-group", async (req, res) => {
  try {
    const { deviceId, groupName } = req.body;
    if (!deviceId || !groupName) {
      return res.status(400).json({ error: "deviceId and groupName are required" });
    }

    // Generate a consistent group ID based on device ID
    const groupId = `group_${deviceId}`;

    // First, remove this device from any other groups it might be in
    const allGroups = await firestore.collection("groups").get();
    const cleanupPromises = [];
    
    allGroups.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members.includes(deviceId) && doc.id !== groupId) {
        // Remove this device from other groups
        cleanupPromises.push(
          firestore.collection("groups").doc(doc.id).update({
            members: admin.firestore.FieldValue.arrayRemove(deviceId)
          })
        );
      }
    });

    await Promise.all(cleanupPromises);

    // Check if group already exists
    const existingGroup = await firestore.collection("groups").doc(groupId).get();
    const isNew = !existingGroup.exists;

    // Create or update the group
    await firestore.collection("groups").doc(groupId).set({
      adminDeviceId: deviceId,
      groupName,
      members: [deviceId], // Start with just the admin
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }, { merge: true }); // merge: true updates if exists, creates if not

    console.log(`Group ${isNew ? 'created' : 'updated'}: ${groupName} (${groupId}) by ${deviceId}`);
    res.json({ 
      success: true, 
      groupId, 
      groupName, 
      message: `Group ${isNew ? 'created' : 'updated'}`,
      isNew 
    });
  } catch (err) {
    console.error("Error creating/updating group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join a group (and leave previous groups)
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

    // First, remove this device from any other groups
    const allGroups = await firestore.collection("groups").get();
    const cleanupPromises = [];
    
    allGroups.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members.includes(deviceId) && doc.id !== groupId) {
        cleanupPromises.push(
          firestore.collection("groups").doc(doc.id).update({
            members: admin.firestore.FieldValue.arrayRemove(deviceId)
          })
        );
      }
    });

    await Promise.all(cleanupPromises);

    // Now add to the new group
    await groupRef.update({
      members: admin.firestore.FieldValue.arrayUnion(deviceId),
      lastUpdated: new Date().toISOString(),
    });

    const groupData = groupDoc.data();
    console.log(`Device ${deviceId} joined group ${groupId} (${groupData.groupName})`);
    res.json({ success: true, message: `Joined group: ${groupData.groupName}` });
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
        memberCount: data.members ? data.members.length : 0,
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
    if (!groupData.members || !groupData.members.includes(senderId)) {
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
    console.log(`Broadcast sent to ${tokens.length} group members from ${senderId} in group ${groupData.groupName}`);
    
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

// ✅ Leave all groups
app.post("/leave-group", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId is required" });
    }

    const groupsSnapshot = await firestore.collection("groups").get();
    const leavePromises = [];
    
    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members.includes(deviceId)) {
        leavePromises.push(
          firestore.collection("groups").doc(doc.id).update({
            members: admin.firestore.FieldValue.arrayRemove(deviceId)
          })
        );
      }
    });

    await Promise.all(leavePromises);
    console.log(`Device ${deviceId} left all groups`);
    res.json({ success: true, message: "Left all groups" });
  } catch (err) {
    console.error("Error leaving groups:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Clean up empty groups (optional - can run periodically)
app.post("/cleanup-groups", async (req, res) => {
  try {
    const groupsSnapshot = await firestore.collection("groups").get();
    const deletePromises = [];
    
    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (!groupData.members || groupData.members.length === 0) {
        deletePromises.push(firestore.collection("groups").doc(doc.id).delete());
      }
    });

    await Promise.all(deletePromises);
    console.log(`Cleaned up ${deletePromises.length} empty groups`);
    res.json({ success: true, deletedCount: deletePromises.length });
  } catch (err) {
    console.error("Error cleaning up groups:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/", (req, res) => res.json({ status: "OK", message: "Knock Knock server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
