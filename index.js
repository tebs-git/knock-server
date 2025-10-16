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

const firestore = admin.firestore();   // ✅ use admin's Firestore

const app = express();
app.use(cors());
app.use(express.json());

// Register device role and token → saves in Firestore
app.post("/register", async (req, res) => {
  try {
    const { role, token } = req.body;
    if (!role || !token) {
      return res.status(400).json({ error: "role and token are required" });
    }

    await firestore.collection("roles").doc(role).set({ token });
    console.log(`Registered ${role} with token ${token}`);

    res.json({ success: true, message: `${role} registered` });
  } catch (err) {
    console.error("Error registering role:", err);
    res.status(500).json({ error: err.message });
  }
});

// Visitor knocks → server looks up door token in Firestore → sends FCM
app.post("/knock", async (req, res) => {
  try {
    const doc = await firestore.collection("roles").doc("door").get();
    if (!doc.exists) {
      return res.status(404).json({ error: "No door registered" });
    }

    const doorToken = doc.data().token;

    const message = {
      token: doorToken,
      // ✅ ADD NOTIFICATION PAYLOAD - This makes the system show the notification
      notification: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪"
      },
      // ✅ KEEP DATA PAYLOAD - For your app's custom handling
      data: {
        type: "knock",
        timestamp: new Date().toISOString()
      },
      // ✅ ADD ANDROID PRIORITY - For vibrate mode and deep sleep
      android: {
        priority: "high"
      },
      // ✅ ADD APNS FOR CROSS-PLATFORM COMPATIBILITY
      apns: {
        payload: {
          aps: {
            contentAvailable: true,
            sound: "default"
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    console.log("Knock sent to door:", response);

    res.json({ success: true, response });
  } catch (err) {
    console.error("Error sending knock:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ ADD ROOT ENDPOINT FOR HEALTH CHECKS
app.get("/", (req, res) => {
  res.json({ 
    status: "OK", 
    message: "Knock Knock Server is running",
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Knock Knock server running on port ${PORT}`);
});
