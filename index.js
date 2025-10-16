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

const app = express();
app.use(cors());
app.use(express.json());

// Simple knock endpoint - back to basics
app.post("/knock", async (req, res) => {
  try {
    console.log("🔔 Knock received at:", new Date().toISOString());
    
    // Get door token from Firestore
    const db = admin.firestore();
    const doorDoc = await db.collection("roles").doc("door").get();
    
    if (!doorDoc.exists) {
      console.log("❌ No door device registered");
      return res.status(400).json({ error: "No door device registered" });
    }

    const doorToken = doorDoc.data().token;
    console.log("✅ Sending to door token");

    // Simple message that should work
    const message = {
      token: doorToken,
      notification: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪"
      },
      data: {
        type: "knock",
        timestamp: new Date().toISOString()
      }
    };

    console.log("📤 Sending FCM message...");
    const response = await admin.messaging().send(message);
    console.log("✅ Message sent successfully:", response);

    res.json({ 
      success: true, 
      message: "Knock sent successfully",
      messageId: response 
    });
    
  } catch (err) {
    console.error("❌ Error sending message:", err);
    res.status(500).json({ 
      error: err.message,
      code: err.code || 'unknown' 
    });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    service: "Knock Knock Server",
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Knock Knock server running on port ${PORT}`);
  console.log(`✅ Health check: https://your-render-url.onrender.com/`);
});
