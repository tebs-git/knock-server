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

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Get complete public IP address
function getCompletePublicIp(req) {
  // Try different headers that might contain the real public IP
  const ip = req.headers['x-forwarded-for'] || 
              req.headers['x-real-ip'] || 
              req.connection.remoteAddress || 
              req.socket.remoteAddress ||
              req.ip ||
              'unknown';
  
  console.log("Raw IP info:", {
    'x-forwarded-for': req.headers['x-forwarded-for'],
    'x-real-ip': req.headers['x-real-ip'],
    'connection.remoteAddress': req.connection.remoteAddress,
    'socket.remoteAddress': req.socket.remoteAddress,
    'req.ip': req.ip
  });
  
  // Extract the first IP if it's a list (common with x-forwarded-for)
  let completeIp = ip;
  if (ip.includes(',')) {
    completeIp = ip.split(',')[0].trim();
  }
  
  // Clean IPv6-mapped IPv4 addresses
  completeIp = completeIp.replace(/^::ffff:/, '');
  
  console.log("Final complete IP:", completeIp);
  return completeIp;
}

// ✅ Register device and report status
app.post("/register", async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) return res.status(400).json({ error: "token and userId required" });

    const publicIp = getCompletePublicIp(req);
    
    // Store in device_status collection
    await firestore.collection("device_status").doc(userId).set({
      fcm_token: token,
      public_ip: publicIp,  // ← COMPLETE IP
      last_seen: new Date().toISOString(),
    });

    console.log(`Registered: ${userId} (COMPLETE IP: ${publicIp})`);
    res.json({ success: true, public_ip: publicIp });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Report device status (IP update)
app.post("/report-status", async (req, res) => {
  try {
    const { token, userId } = req.body;
    if (!token || !userId) return res.status(400).json({ error: "token and userId required" });

    const publicIp = getCompletePublicIp(req);
    
    await firestore.collection("device_status").doc(userId).set({
      fcm_token: token,
      public_ip: publicIp,  // ← COMPLETE IP
      last_seen: new Date().toISOString(),
    }, { merge: true });

    console.log(`Status updated: ${userId} -> COMPLETE IP: ${publicIp}`);
    res.json({ success: true, public_ip: publicIp });
  } catch (err) {
    console.error("Status update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Send knock (Core functionality)
app.post("/send-knock", async (req, res) => {
  try {
    const { senderUserId, receiverUserId } = req.body;
    if (!senderUserId || !receiverUserId) return res.status(400).json({ error: "senderUserId and receiverUserId required" });

    const senderIp = getCompletePublicIp(req);
    
    // Get receiver's status
    const receiverDoc = await firestore.collection("device_status").doc(receiverUserId).get();
    if (!receiverDoc.exists) return res.status(404).json({ error: "Receiver not found" });

    const receiverData = receiverDoc.data();
    const receiverIp = receiverData.public_ip;
    const receiverToken = receiverData.fcm_token;

    console.log(`IP Comparison: Sender=${senderIp}, Receiver=${receiverIp}`);

    if (!receiverToken) return res.status(404).json({ error: "Receiver token not available" });

    // Proximity check - compare COMPLETE IPs
    if (senderIp === receiverIp) {
      // Send FCM notification
      await admin.messaging().send({
        token: receiverToken,
        data: { type: "knock", timestamp: new Date().toISOString(), senderId: senderUserId },
        android: { priority: "high" },
      });

      console.log(`✅ Knock delivered: ${senderUserId} -> ${receiverUserId} (Same network: ${senderIp})`);
      res.json({ success: true, message: "Knock delivered" });
    } else {
      console.log(`🚫 Knock blocked: Different networks (${senderIp} vs ${receiverIp})`);
      res.status(400).json({ error: "Knock failed (remote location)" });
    }
  } catch (err) {
    console.error("Send knock error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ... keep the rest of your endpoints (create-group, join-group, etc.) the same

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 Knock Knock server running on port ${PORT}`);
});
