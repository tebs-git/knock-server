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

// ✅ Register a device role and token (door / visitor)
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

// ✅ Visitor knocks → send FCM message to door
app.post("/knock", async (req, res) => {
  try {
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
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    const response = await admin.messaging().send(message);
    console.log("Knock sent to door:", response);

    res.json({ success: true, response });
  } catch (err) {
    console.error("Error sending knock:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "OK", message: "Server running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
