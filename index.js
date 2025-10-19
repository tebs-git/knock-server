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

// Register device role and token
app.post("/register", async (req, res) => {
  try {
    const { role, token } = req.body;
    if (!role || !token) {
      return res.status(400).json({ error: "role and token are required" });
    }

    await firestore.collection("roles").doc(role).set({ token });
    console.log(`Registered ${role} with token`);

    res.json({ success: true, message: `${role} registered` });
  } catch (err) {
    console.error("Error registering role:", err);
    res.status(500).json({ error: err.message });
  }
});

// Visitor knocks - DATA-ONLY MESSAGE
app.post("/knock", async (req, res) => {
  try {
    console.log("🔔 Knock endpoint hit");
    
    const doc = await firestore.collection("roles").doc("door").get();
    if (!doc.exists) {
      console.log("❌ No door registered");
      return res.status(404).json({ error: "No door registered" });
    }

    const doorToken = doc.data().token;
    console.log("✅ Sending to door token");

    const message = {
      token: doorToken,
      // ✅ DATA-ONLY - This forces Android to call onMessageReceived()
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
        timestamp: new Date().toISOString()
      },
      android: {
        priority: "high"  // ✅ Wake up device
      }
    };

    console.log("📤 Sending data-only FCM message...");
    const response = await admin.messaging().send(message);
    console.log("✅ Data-only message sent successfully");

    res.json({ success: true, response });
  } catch (err) {
    console.error("❌ Error sending knock:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "Knock Knock Server is running",
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Knock Knock server running on port ${PORT}`);
});
