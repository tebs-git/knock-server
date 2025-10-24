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

// ✅ Broadcast a knock to all other devices with HIGH PRIORITY FCM
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

    // HIGH PRIORITY FCM message to wake phones from Doze
    const message = {
      tokens,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        senderId: senderId,
        verificationToken: verificationToken || "default",
        type: "knock",
        timestamp: new Date().toISOString(),
      },
      android: {
        priority: "high",        // ← HIGH PRIORITY for Android
        ttl: 30000,              // 30 seconds time to live
        notification: {
          sound: "default",
          priority: "max",       // ← MAX PRIORITY notification
          default_sound: true,
          default_vibrate_timings: true,
          default_light_settings: true
        }
      },
      apns: {
        headers: {
          "apns-priority": "10", // ← HIGHEST PRIORITY for iOS
          "apns-push-type": "alert"
        },
        payload: {
          aps: {
            contentAvailable: 1, // ← Wake up iOS apps
            alert: {
              title: "Knock Knock!",
              body: "Someone is at the door 🚪"
            },
            sound: "default",
            badge: 1
          }
        }
      },
      webpush: {
        headers: {
          Urgency: "high"        // ← HIGH PRIORITY for Web
        }
      }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`HIGH PRIORITY broadcast sent to ${tokens.length} devices`);
    console.log(`Success count: ${response.successCount}, Failure count: ${response.failureCount}`);
    
    res.json({ 
      success: true, 
      count: tokens.length, 
      response: {
        successCount: response.successCount,
        failureCount: response.failureCount
      }
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
