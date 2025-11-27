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

// ✅ Health check that also wakes up the server
app.get("/health", async (req, res) => {
  try {
    // This request wakes up the server if it was sleeping
    const timestamp = new Date().toISOString();
    console.log(`Health check - Server awakened at: ${timestamp}`);
    
    res.json({ 
      status: "OK", 
      message: "Knock Knock server running",
      timestamp: timestamp,
      wokeUp: true
    });
  } catch (err) {
    console.error("Health check error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Register device
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

// ✅ Create group with SSID registration
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName, currentSsid } = req.body;
    if (!token || !groupName) {
      return res.status(400).json({ error: "token and groupName are required" });
    }

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const groupData = {
      name: groupName,
      code: groupCode,
      registeredSSID: currentSsid || null,
      createdBy: token,
      createdAt: Date.now(),
      members: {
        [token]: {
          joinedAt: Date.now(),
          currentWifiStatus: currentSsid || "unknown",
          lastUpdated: new Date().toISOString()
        }
      }
    };

    await firestore.collection("groups").doc(groupCode).set(groupData);

    console.log(`Group created: ${groupName} (${groupCode}) with SSID: ${currentSsid}`);
    res.json({ success: true, groupCode, groupName, registeredSSID: currentSsid });
  } catch (err) {
    console.error("Error creating group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group with SSID
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode, currentSsid } = req.body;
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
        currentWifiStatus: currentSsid || "unknown",
        lastUpdated: new Date().toISOString()
      }
    });

    const groupData = groupDoc.data();
    console.log(`Token ${token.substring(0, 10)}... joined group ${groupCode} with SSID: ${currentSsid}`);
    res.json({ success: true, groupName: groupData.name, groupCode, registeredSSID: groupData.registeredSSID });
  } catch (err) {
    console.error("Error joining group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update device WiFi status
app.post("/update-wifi-status", async (req, res) => {
  try {
    const { token, groupCode, wifiStatus } = req.body;
    if (!token || !groupCode) {
      return res.status(400).json({ error: "token and groupCode are required" });
    }

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    // Update member's WiFi status
    await groupRef.update({
      [`members.${token}.currentWifiStatus`]: wifiStatus,
      [`members.${token}.lastUpdated`]: new Date().toISOString()
    });

    console.log(`Updated WiFi status for ${token.substring(0, 10)}...: ${wifiStatus}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating WiFi status:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send knock only if someone is home
app.post("/home-knock", async (req, res) => {
  try {
    const { token, groupCode, currentSsid } = req.body;
    if (!token || !groupCode) {
      return res.status(400).json({ error: "token and groupCode are required" });
    }

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    
    // Check if sender is member
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a group member" });
    }

    // Check if group has registered SSID (set when group was created)
    if (!groupData.registeredSSID) {
      return res.status(400).json({ error: "Group has no registered home network" });
    }

    // Check if ANY group member is currently on the home network
    let someoneHome = false;
    const tokens = [];
    
    for (const [memberToken, memberInfo] of Object.entries(groupData.members)) {
      if (memberToken !== token) { // Exclude sender
        const currentWifiStatus = memberInfo.currentWifiStatus;
        
        // Check if member is connected to the registered home SSID
        if (currentWifiStatus === groupData.registeredSSID) {
          someoneHome = true;
          
          // Get device token for FCM
          const deviceDoc = await firestore.collection("devices").doc(memberToken).get();
          if (deviceDoc.exists && deviceDoc.data().token) {
            tokens.push(deviceDoc.data().token);
          }
        }
      }
    }

    if (!someoneHome) {
      return res.status(400).json({ error: "No one home" });
    }

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No valid device tokens found" });
    }

    // Send FCM notifications
    const message = {
      tokens,
      data: {
        title: "🔔 Knock Knock!",
        body: "Someone is at the door!",
        type: "knock",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    await admin.messaging().sendEachForMulticast(message);
    console.log(`Home knock sent from ${token.substring(0, 10)}... to ${tokens.length} home devices`);
    res.json({ success: true, count: tokens.length, message: "Knock delivered to home devices" });
  } catch (err) {
    console.error("Error sending home knock:", err);
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
          registeredSSID: groupData.registeredSSID,
          createdBy: groupData.createdBy,
          memberCount: Object.keys(groupData.members).length,
          isAdmin: groupData.createdBy === token,
          joinedAt: groupData.members[token].joinedAt,
          currentWifiStatus: groupData.members[token].currentWifiStatus
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
