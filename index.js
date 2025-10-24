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

// Store active knock sessions
const activeKnocks = new Map();

// ✅ Register a device with its token AND local IP
app.post("/register", async (req, res) => {
  try {
    const { deviceId, token, name, localIP } = req.body;
    if (!deviceId || !token) {
      return res.status(400).json({ error: "deviceId and token are required" });
    }

    await firestore.collection("devices").doc(deviceId).set({
      token,
      name: name || "Unknown Device",
      localIP: localIP || "",
      lastActive: new Date().toISOString(),
    });

    console.log(`Registered device: ${deviceId} with IP: ${localIP}`);
    res.json({ success: true, message: `Device ${deviceId} registered` });
  } catch (err) {
    console.error("Error registering device:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Broadcast a knock to all other devices
app.post("/broadcast", async (req, res) => {
  try {
    const { senderId, localIP } = req.body;
    if (!senderId) return res.status(400).json({ error: "senderId required" });

    const snapshot = await firestore.collection("devices").get();
    const tokens = [];
    const recipientIPs = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.token && doc.id !== senderId) {
        tokens.push(data.token);
        if (data.localIP) {
          recipientIPs.push(data.localIP);
        }
      }
    });

    if (tokens.length === 0) {
      return res.status(404).json({ error: "No other devices registered" });
    }

    // Create knock session
    const knockId = Date.now().toString();
    activeKnocks.set(knockId, {
      senderId,
      senderIP: localIP,
      recipientIPs,
      timestamp: Date.now()
    });

    // Send FCM message with knock ID
    const message = {
      tokens,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
        knockId: knockId,
        senderIP: localIP || "",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`FCM sent to ${tokens.length} devices from ${senderId}`);
    
    res.json({ 
      success: true, 
      count: tokens.length, 
      knockId: knockId,
      recipientIPs: recipientIPs 
    });
  } catch (err) {
    console.error("Error broadcasting:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Confirm WiFi message was received
app.post("/wifi-received", async (req, res) => {
  try {
    const { knockId, receiverId } = req.body;
    console.log(`WiFi message received confirmation for knock ${knockId} from ${receiverId}`);
    
    // Clean up old knock sessions (older than 5 minutes)
    const now = Date.now();
    for (let [id, session] of activeKnocks.entries()) {
      if (now - session.timestamp > 300000) {
        activeKnocks.delete(id);
      }
    }
    
    res.json({ success: true, message: "WiFi receipt confirmed" });
  } catch (err) {
    console.error("Error confirming WiFi receipt:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Get knock session info for UDP follow-up
app.get("/knock-session/:knockId", (req, res) => {
  const knockId = req.params.knockId;
  const session = activeKnocks.get(knockId);
  
  if (!session) {
    return res.status(404).json({ error: "Knock session not found" });
  }
  
  res.json(session);
});

// ✅ Health check
app.get("/", (req, res) => res.json({ status: "OK", message: "Knock Knock server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
