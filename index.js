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

app.post("/", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "No token provided" });

    const message = {
      token,
      android: { priority: "high" },
      data: {
        title: "Knock Knock!",
        body: "Someone is at the door 🚪",
        type: "knock",
      },
    };

    const response = await admin.messaging().send(message);
    console.log("Message sent successfully:", response);

    res.json({ success: true, response });
  } catch (err) {
    console.error("Error sending message:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Knock Knock server running on port ${PORT}`));
