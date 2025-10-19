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
    console.log("🎯 KNOCK ENDPOINT HIT - DATA-ONLY VERSION");
    
    const doc = await firestore.collection("roles").doc("door").get();
    if (!doc.exists) {
      return res.status(404).json({ error: "No door registered" });
    }

    const doorToken = doc.data().token;

    const message = {
      token: doorToken,
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
        debug: "DATA-ONLY-MESSAGE"
      },
      android: {
        priority: "high"
      }
    };

    console.log("📤 SENDING DATA-ONLY MESSAGE:", JSON.stringify(message));
    
    const response = await admin.messaging().send(message);
    console.log("✅ DATA-ONLY MESSAGE SENT TO FCM");

    res.json({ success: true, message: "Data-only knock sent" });
  } catch (err) {
    console.error("❌ Error:", err);
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


