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

// ✅ Register a device with its token AND home network
app.post("/register", async (req, res) => {
  try {
    const { deviceId, token, name, currentSSID } = req.body;
    if (!deviceId || !token) {
      return res.status(400).json({ error: "deviceId and token are required" });
    }

    await firestore.collection("devices").doc(deviceId).set({
      token,
      name: name || "Unknown Device",
      homeSSID: currentSSID || "Unknown", // Store the home network
      lastActive: new Date().toISOString(),
    });

    console.log(`Registered device: ${deviceId} on network: ${currentSSID}`);
    res.json({ success: true, message: `Device ${deviceId} registered on ${currentSSID}` });
  } catch (err) {
    console.error("Error registering device:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Check if current network matches registered network
app.post("/check-network", async (req, res) => {
  try {
    const { deviceId, currentSSID } = req.body;
    if (!deviceId || !currentSSID) {
      return res.status(400).json({ error: "deviceId and currentSSID are required" });
    }

    const doc = await firestore.collection("devices").doc(deviceId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "Device not registered" });
    }

    const deviceData = doc.data();
    const isRegistered = deviceData.homeSSID === currentSSID;

    res.json({ 
      isRegistered,
      currentSSID,
      homeSSID: deviceData.homeSSID 
    });
  } catch (err) {
    console.error("Error checking network:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Broadcast a knock to all other devices (with network verification)
app.post("/broadcast", async (req, res) => {
  try {
    const { senderId, currentSSID } = req.body;
    if (!senderId) return res.status(400).json({ error: "senderId required" });

    // Verify sender is on their registered network
    const senderDoc = await firestore.collection("devices").doc(senderId).get();
    if (!senderDoc.exists) {
      return res.status(404).json({ error: "Sender device not registered" });
    }

    const senderData = senderDoc.data();
    if (senderData.homeSSID !== currentSSID) {
      return res.status(403).json({ error: "Not on home network" });
    }

    const snapshot = await firestore.collection("devices").get();
    const tokens = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.token && doc.id !== senderId) tokens.push(data.token);
    });

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other devices registered" });
    }

    const message = {
      tokens,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`Broadcast sent to ${tokens.length} devices from ${senderId}`);
    res.json({ success: true, count: tokens.length, response });
  } catch (err) {
    console.error("Error broadcasting:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Health check
app.get("/", (req, res) => res.json({ status: "OK", message: "Knock Knock server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
