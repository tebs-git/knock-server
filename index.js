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

// ✅ Register a device with its token
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

// ✅ Broadcast a knock to all other devices - DATA MESSAGES ONLY
app.post("/broadcast", async (req, res) => {
  try {
    const { senderId, verificationToken } = req.body;
    if (!senderId) return res.status(400).json({ error: "senderId required" });

    const snapshot = await firestore.collection("devices").get();
    const tokens = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.token && doc.id !== senderId) tokens.push(data.token);
    });

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other devices registered" });
    }

    // DATA-ONLY MESSAGE - This ensures onMessageReceived() is always called
    const message = {
      tokens,
      // NO "notification" field - this is crucial!
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        senderId: senderId,
        verificationToken: verificationToken || "default", 
        type: "knock",
        timestamp: new Date().toISOString(),
        click_action: "OPEN_MAIN_ACTIVITY" // Optional: action when notification clicked
      },
      android: {
        priority: "high",
        ttl: 30000, // 30 seconds
        // No notification configuration here - only in data
      },
      apns: {
        headers: {
          "apns-priority": "10",
        },
        payload: {
          aps: {
            contentAvailable: 1, // Wake up iOS apps
            // No "alert" here - we handle notification in app
            sound: "default",
            badge: 1
          }
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`DATA-ONLY broadcast sent to ${tokens.length} devices`);
    
    res.json({ 
      success: true, 
      count: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount
    });
  } catch (err) {
    console.error("Error broadcasting:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/", (req, res) => res.json({ status: "OK", message: "Knock Knock server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
