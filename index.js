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

// Health check
app.get("/health", async (req, res) => {
  try {
    const timestamp = new Date().toISOString();
    res.json({ 
      status: "OK", 
      message: "Knock Knock server running",
      timestamp: timestamp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register device
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

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create group - FIXED: Handle users without myGroups field
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) {
      return res.status(400).json({ error: "token and groupName are required" });
    }

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const groupData = {
      name: groupName,
      code: groupCode,
      createdBy: token,
      createdAt: Date.now(),
      members: {
        [token]: {
          joinedAt: Date.now(),
          role: "admin"
        }
      }
    };

    // Create the group first
    await firestore.collection("groups").doc(groupCode).set(groupData);

    // Then update user with myGroups - use set with merge to handle both cases
    await firestore.collection("devices").doc(token).set({
      myGroups: {
        [groupCode]: {
          groupName: groupName,
          joinedAt: Date.now(),
          role: "admin"
        }
      }
    }, { merge: true }); // This is key - merge doesn't overwrite existing data

    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Join group - FIXED: Handle users without myGroups field
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) {
      return res.status(400).json({ error: "token and groupCode are required" });
    }

    const normalizedGroupCode = groupCode.toUpperCase();
    const groupRef = firestore.collection("groups").doc(normalizedGroupCode);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();

    // Add user to group
    await groupRef.update({
      [`members.${token}`]: {
        joinedAt: Date.now(),
        role: "member"
      }
    });

    // Add group to user's myGroups - use set with merge
    await firestore.collection("devices").doc(token).set({
      myGroups: {
        [normalizedGroupCode]: {
          groupName: groupData.name,
          joinedAt: Date.now(),
          role: "member"
        }
      }
    }, { merge: true });

    res.json({ success: true, groupName: groupData.name, groupCode: normalizedGroupCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user's groups - FIXED: Handle users without myGroups field
app.post("/my-groups", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: "token is required" });
    }

    const userDoc = await firestore.collection("devices").doc(token).get();
    
    if (!userDoc.exists) {
      return res.json({ success: true, groups: [] });
    }

    const userData = userDoc.data();
    const userGroups = [];

    // Check if user has myGroups field, if not return empty array
    if (userData.myGroups) {
      const groupCodes = Object.keys(userData.myGroups);
      
      for (const groupCode of groupCodes) {
        const groupDoc = await firestore.collection("groups").doc(groupCode).get();
        if (groupDoc.exists) {
          const groupData = groupDoc.data();
          const userGroupInfo = userData.myGroups[groupCode];
          
          userGroups.push({
            groupCode: groupCode,
            groupName: groupData.name,
            memberCount: groupData.members ? Object.keys(groupData.members).length : 0,
            isAdmin: userGroupInfo.role === "admin",
            joinedAt: userGroupInfo.joinedAt
          });
        }
      }

      userGroups.sort((a, b) => b.joinedAt - a.joinedAt);
    }

    res.json({ success: true, groups: userGroups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send knock to group
app.post("/broadcast-to-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) {
      return res.status(400).json({ error: "token and groupCode are required" });
    }

    const groupDoc = await firestore.collection("groups").doc(groupCode.toUpperCase()).get();
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a group member" });
    }

    const tokens = [];
    for (const [memberToken, memberInfo] of Object.entries(groupData.members)) {
      if (memberToken !== token) {
        const deviceDoc = await firestore.collection("devices").doc(memberToken).get();
        if (deviceDoc.exists && deviceDoc.data().token) {
          tokens.push(deviceDoc.data().token);
        }
      }
    }

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other group members" });
    }

    const message = {
      tokens,
      data: {
        title: "Wake Up!",
        body: "Listening for knock...",
        type: "wakeup",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    await admin.messaging().sendEachForMulticast(message);
    res.json({ success: true, count: tokens.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root endpoint
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
});
