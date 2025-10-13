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

app.post("/knock", async (req, res) => {
  try {
    console.log("Knock request received");
    
    // Get door token from Firestore (you'll need to implement this)
    const db = admin.firestore();
    const doorDoc = await db.collection("roles").doc("door").get();
    
    if (!doorDoc.exists) {
      console.log("No door device registered");
      return res.status(400).json({ error: "No door device registered" });
    }

    const doorToken = doorDoc.data().token;
    console.log("Sending to door token:", doorToken);

    const message = {
      token: doorToken,
      notification: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪"
      },
      data: {
        type: "knock",
        timestamp: new Date().toISOString()
      },
      android: {
        priority: "high",
        ttl: 60 * 60 * 24 // 24 hours in seconds
      },
      apns: {
        headers: {
          "apns-priority": "10"
        },
        payload: {
          aps: {
            contentAvailable: true,
            sound: "default"
          }
        }
      }
    };

    console.log("Sending FCM message...");
    const response = await admin.messaging().send(message);
    console.log("Message sent successfully:", response);

    res.json({ 
      success: true, 
      message: "Knock sent successfully",
      messageId: response 
    });
    
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ 
      error: err.message,
      code: err.code || 'unknown' 
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Test endpoint to verify server is working
app.post("/test", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "No token provided" });

    const message = {
      token: token,
      notification: {
        title: "Test Notification",
        body: "This is a test message from your server"
      },
      android: {
        priority: "high"
      }
    };

    const response = await admin.messaging().send(message);
    console.log("Test message sent successfully:", response);

    res.json({ success: true, response });
  } catch (err) {
    console.error("Error sending test message:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
