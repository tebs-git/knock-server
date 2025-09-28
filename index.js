const { Firestore } = require('@google-cloud/firestore');
const firestore = new Firestore();
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

// In-memory token store (reset when server restarts)
const tokens = {};

// Register device role and token
app.post("/register", (req, res) => {
  const { role, token } = req.body;
  if (!role || !token) {
    return res.status(400).json({ error: "role and token are required" });
  }
  tokens[role] = token;
  console.log(`Registered ${role} with token ${token}`);
  res.json({ success: true, message: `${role} registered` });
});

// Visitor knocks on door
app.post("/knock", async (req, res) => {
  const doorToken = tokens["door"];
  if (!doorToken) {
    return res.status(400).json({ error: "No door device registered" });
  }

  const message = {
    token: doorToken,
    data: { type: "knock" },
    notification: {
      title: "Knock Knock!",
      body: "Someone is at the door 🚪",
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log("Knock sent to door:", response);
    res.json({ success: true });
  } catch (err) {
    console.error("Error sending knock:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Knock Knock server running on port ${PORT}`);
});

