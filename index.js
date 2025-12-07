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

// Temporary storage for knock attempts (in-memory, reset on server restart)
const pendingKnocks = new Map();

// ✅ Get consistent public IP address
function getCompletePublicIp(req) {
  let ip = req.headers['x-forwarded-for'];
  
  if (ip) {
    const ipChain = ip.split(',').map(i => i.trim());
    const clientIp = ipChain[0];
    const cleanIp = clientIp.replace(/^::ffff:/, '');
    return cleanIp;
  }
  
  ip = req.ip || 
       req.connection.remoteAddress || 
       req.socket.remoteAddress || 
       'unknown';
  
  return ip.replace(/^::ffff:/, '');
}

// ✅ Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// ✅ Create group
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) return res.status(400).json({ error: "token and groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const userIp = getCompletePublicIp(req);
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: { 
        [token]: { 
          joinedAt: Date.now(),
          last_active: new Date().toISOString()
        } 
      }
    });

    console.log(`Group created: ${groupName} (${groupCode})`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Create group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join group
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    await groupRef.update({
      [`members.${token}`]: { 
        joinedAt: Date.now(),
        last_active: new Date().toISOString()
      }
    });

    const groupData = groupDoc.data();
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ STEP 1: Knock Attempt - Sender initiates knock
app.post("/knock-attempt", async (req, res) => {
  try {
    const { senderToken, groupCode } = req.body;
    if (!senderToken || !groupCode) {
      return res.status(400).json({ error: "senderToken and groupCode required" });
    }

    const senderIp = getCompletePublicIp(req);
    
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    const groupData = groupDoc.data();
    const members = groupData.members || {};
    
    if (!members[senderToken]) {
      return res.status(403).json({ error: "You are not a member of this group" });
    }

    // Store knock attempt data
    const knockId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    const pendingData = {
      knockId,
      senderToken,
      senderIp,
      groupCode: groupCode.toUpperCase(),
      timestamp: Date.now(),
      receiversReported: new Set() // Track which receivers have reported IP
    };
    
    pendingKnocks.set(knockId, pendingData);
    
    // Set timeout to clean up after 30 seconds
    setTimeout(() => {
      if (pendingKnocks.has(knockId)) {
        console.log(`🧹 Cleaning up expired knock attempt: ${knockId}`);
        pendingKnocks.delete(knockId);
      }
    }, 30000);

    // Send first notification to all other group members
    const promises = [];
    const receiverTokens = [];
    
    for (const [memberToken, memberData] of Object.entries(members)) {
      if (memberToken !== senderToken) {
        receiverTokens.push(memberToken);
        
        const message = {
          token: memberToken,
          data: {
            title: "🔍 Knock Attempt",
            body: "Someone is checking if you're home...",
            type: "knock-attempt",
            knockId: knockId,
            senderToken: senderToken,
            timestamp: Date.now().toString()
          },
          android: {
            priority: "high"
          },
          apns: {
            payload: {
              aps: {
                contentAvailable: true,
                alert: {
                  title: "🔍 Knock Attempt",
                  body: "Someone is checking if you're home..."
                },
                sound: "default"
              }
            }
          }
        };
        promises.push(admin.messaging().send(message));
      }
    }

    if (receiverTokens.length === 0) {
      pendingKnocks.delete(knockId);
      return res.status(400).json({ 
        success: false,
        error: "No one else in the group"
      });
    }

    await Promise.all(promises);
    
    console.log(`📤 Knock attempt ${knockId} sent to ${receiverTokens.length} receiver(s)`);
    console.log(`   Sender IP: ${senderIp}, Group: ${groupCode}`);
    
    res.json({ 
      success: true, 
      message: `Checking ${receiverTokens.length} person(s) on this WiFi...`,
      knockId: knockId,
      count: receiverTokens.length
    });

  } catch (err) {
    console.error("Knock attempt error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ STEP 2: Report IP - Receiver reports current IP when they get knock-attempt
app.post("/report-ip", async (req, res) => {
  try {
    const { token, knockId } = req.body;
    if (!token || !knockId) {
      return res.status(400).json({ error: "token and knockId required" });
    }

    const receiverIp = getCompletePublicIp(req);
    
    // Find the pending knock attempt
    const pendingData = pendingKnocks.get(knockId);
    if (!pendingData) {
      return res.status(404).json({ error: "Knock attempt not found or expired" });
    }

    // Store receiver's IP
    pendingData.receiversReported.add(token);
    
    console.log(`📱 Receiver ${token.substring(0, 8)}... reported IP: ${receiverIp} for knock ${knockId}`);
    
    // Check if IPs match (same WiFi network)
    const isSameNetwork = (receiverIp === pendingData.senderIp);
    
    // Schedule the second notification in 2 seconds
    setTimeout(async () => {
      try {
        if (isSameNetwork) {
          // IPs match - send actual knock notification
          const message = {
            token: token,
            data: {
              title: "🚪 Door Knock!",
              body: "Someone is at your door!",
              type: "actual-knock",
              knockId: knockId,
              timestamp: Date.now().toString()
            },
            android: {
              priority: "high"
            },
            apns: {
              payload: {
                aps: {
                  contentAvailable: true,
                  alert: {
                    title: "🚪 Door Knock!",
                    body: "Someone is at your door!"
                  },
                  sound: "default"
                }
              }
            }
          };
          
          await admin.messaging().send(message);
          console.log(`✅ Actual knock sent to ${token.substring(0, 8)}... (IP match: ${receiverIp})`);
        } else {
          console.log(`❌ IP mismatch for ${token.substring(0, 8)}...: ${receiverIp} vs ${pendingData.senderIp}`);
          // No second notification sent - they're not on the same WiFi
        }
      } catch (error) {
        console.error("Error sending second notification:", error);
      }
    }, 4000); // 4 second delay 

    res.json({ 
      success: true, 
      message: "IP reported successfully",
      isSameNetwork: isSameNetwork,
      receiverIp: receiverIp,
      senderIp: pendingData.senderIp
    });

  } catch (err) {
    console.error("Report IP error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Get user's groups
app.post("/my-groups", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "token required" });

    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];

    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members[token]) {
        userGroups.push({
          groupCode: doc.id,
          groupName: groupData.name,
          memberCount: Object.keys(groupData.members).length
        });
      }
    });

    res.json({ success: true, groups: userGroups });
  } catch (err) {
    console.error("Get groups error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Cleanup endpoint (optional, for debugging)
app.get("/cleanup-pending", (req, res) => {
  const before = pendingKnocks.size;
  pendingKnocks.clear();
  res.json({ 
    success: true, 
    message: `Cleaned up ${before} pending knocks`,
    remaining: pendingKnocks.size 
  });
});

// ✅ Status endpoint (for debugging)
app.get("/pending-status", (req, res) => {
  const pendingList = Array.from(pendingKnocks.entries()).map(([id, data]) => ({
    knockId: id,
    senderToken: data.senderToken.substring(0, 8) + '...',
    senderIp: data.senderIp,
    groupCode: data.groupCode,
    timestamp: new Date(data.timestamp).toISOString(),
    receiversReported: Array.from(data.receiversReported).map(t => t.substring(0, 8) + '...')
  }));
  
  res.json({
    success: true,
    pendingCount: pendingKnocks.size,
    pendingKnocks: pendingList
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚪 WiFi Knock Knock Server running on port ${PORT}`);
  console.log(`🎯 Two-step knock system active:`);
  console.log(`   1. Knock attempt → "Checking if you're home..."`);
  console.log(`   2. IP report → 2s delay → Actual knock if same WiFi`);
  console.log(`   🔥 No more automatic network monitoring!`);
});

