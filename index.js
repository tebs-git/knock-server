const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// ✅ Initialize Firebase Admin using Render environment variables
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

// 🪪 Register device with token
app.post("/register", async (req, res) => {
  try {
    const { deviceId, token } = req.body;
    if (!deviceId || !token) {
      return res.status(400).json({ error: "deviceId and token are required" });
    }

    await firestore.collection("devices").doc(deviceId).set({
      token,
      lastRegistered: new Date().toISOString()
    });

    console.log(`✅ Registered ${deviceId}`);
    res.json({ success: true, message: `${deviceId} registered` });
  } catch (err) {
    console.error("Error registering device:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🚪 Handle “Send Knock”
app.post("/knock", async (req, res) => {
  try {
    const { senderId, current_ssid, current_bssid } = req.body;

    if (!senderId || !current_ssid || !current_bssid) {
      return res.status(400).json({ error: "senderId, ssid, and bssid are required" });
    }

    const householdRef = firestore.collection("households").doc("default");
    const householdDoc = await householdRef.get();

    // 🏡 If first time → store this Wi-Fi as household network
    if (!householdDoc.exists) {
      await householdRef.set({
        trusted_ssid: current_ssid,
        trusted_bssid: current_bssid,
        registeredAt: new Date().toISOString()
      });
      console.log("🏠 Stored new household Wi-Fi fingerprint");
    } else {
      // Verify Wi-Fi match
      const { trusted_bssid } = householdDoc.data();
      if (trusted_bssid !== current_bssid) {
        console.warn("❌ Knock rejected: wrong Wi-Fi");
        return res.status(403).json({ error: "Not connected to the household Wi-Fi" });
      }
    }

    // 📱 Get all registered devices (except sender)
    const snapshot = await firestore.collection("devices").get();
    const tokens = [];
    snapshot.forEach(doc => {
      if (doc.id !== senderId && doc.data().token) {
        tokens.push(doc.data().token);
      }
    });

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other registered devices found" });
    }

    // 🔔 Create FCM data payload
    const message = {
      tokens,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
        timestamp: new Date().toISOString()
      },
      android: {
        priority: "high"
      }
    };

    const response = await admin.messaging().sendMulticast(message);
    console.log(`📨 Knock sent: ${response.successCount} successes, ${response.failureCount} failures`);

    res.json({
      success: true,
      sent: response.successCount,
      failed: response.failureCount
    });
  } catch (err) {
    console.error("Error sending knock:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🧭 Health check route
app.get("/", (req, res) => {
  res.json({ status: "OK", message: "Knock Knock server running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Knock Knock server running on port ${PORT}`);
});
