const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const app = express();
app.use(cors());
app.use(express.json());

// ✅ ADD THIS - Root endpoint for health checks
app.get("/", (req, res) => {
  console.log("✅ Root endpoint hit - server is working");
  res.json({ 
    status: "OK", 
    message: "Knock Knock Server is running!",
    timestamp: new Date().toISOString()
  });
});

// ✅ Knock endpoint
app.post("/knock", async (req, res) => {
  try {
    console.log("🔔 KNOCK ENDPOINT HIT!");
    
    const db = admin.firestore();
    const doorDoc = await db.collection("roles").doc("door").get();
    
    if (!doorDoc.exists) {
      console.log("❌ No door registered");
      return res.status(400).json({ error: "No door registered" });
    }

    const doorToken = doorDoc.data().token;
    console.log("✅ Door token found");

    const message = {
      token: doorToken,
      notification: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪"
      },
      data: {
        type: "knock"
      },
      android: {
        priority: "high"
      }
    };

    console.log("📤 Sending FCM message...");
    const response = await admin.messaging().send(message);
    console.log("✅ FCM Message sent successfully!");

    res.json({ success: true, message: "Knock sent!" });
    
  } catch (err) {
    console.error("❌ ERROR in knock endpoint:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
