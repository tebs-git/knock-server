// In index.js - Update create-group and join-group to register devices:

// ✅ Register device helper
async function registerDevice(token) {
  try {
    await firestore.collection("devices").doc(token).set({
      token: token,
      lastActive: new Date().toISOString(),
    }, { merge: true });
    console.log(`Device registered: ${token.substring(0, 10)}...`);
  } catch (err) {
    console.error("Device registration error:", err);
  }
}

// ✅ Then update create-group:
app.post("/create-group", async (req, res) => {
  try {
    const { token, groupName } = req.body;
    if (!token || !groupName) return res.status(400).json({ error: "token and groupName required" });

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const publicIp = getCompletePublicIp(req);
    
    // Register device first
    await registerDevice(token);
    
    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: {
        [token]: {
          publicIp: publicIp,
          lastUpdated: new Date().toISOString()
        }
      }
    });

    console.log(`Group created: ${groupName} (${groupCode}) - Creator IP: ${publicIp}`);
    res.json({ success: true, groupCode, groupName });
  } catch (err) {
    console.error("Create group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update join-group:
app.post("/join-group", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const publicIp = getCompletePublicIp(req);
    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    // Register device first
    await registerDevice(token);

    await groupRef.update({
      [`members.${token}`]: {
        publicIp: publicIp,
        lastUpdated: new Date().toISOString()
      }
    });

    const groupData = groupDoc.data();
    console.log(`Token ${token.substring(0, 10)}... joined group ${groupCode} (IP: ${publicIp})`);
    res.json({ success: true, groupName: groupData.name, groupCode });
  } catch (err) {
    console.error("Join group error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Update send-knock to get tokens from devices collection:
app.post("/send-knock", async (req, res) => {
  try {
    const { token, groupCode } = req.body;
    if (!token || !groupCode) return res.status(400).json({ error: "token and groupCode required" });

    const senderIp = getCompletePublicIp(req);
    console.log(`Knock attempt: ${token.substring(0, 10)}... (IP: ${senderIp}) to group ${groupCode}`);

    const groupRef = firestore.collection("groups").doc(groupCode.toUpperCase());
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) return res.status(404).json({ error: "Group not found" });

    const groupData = groupDoc.data();
    
    // Check if sender is in the group
    if (!groupData.members || !groupData.members[token]) {
      return res.status(403).json({ error: "Not a group member" });
    }

    // Update sender's IP
    await groupRef.update({
      [`members.${token}.publicIp`]: senderIp,
      [`members.${token}.lastUpdated`]: new Date().toISOString()
    });

    // Find other members with same IP
    const matchingMembers = [];
    
    for (const [memberToken, memberData] of Object.entries(groupData.members)) {
      if (memberToken !== token && memberData.publicIp === senderIp) {
        matchingMembers.push(memberToken);
      }
    }

    console.log(`IP match check: ${senderIp} found ${matchingMembers.length} matching members`);

    if (matchingMembers.length === 0) {
      return res.status(400).json({ error: "No one home (different network)" });
    }

    // Get device documents to verify tokens exist
    const validTokens = [];
    for (const memberToken of matchingMembers) {
      const deviceDoc = await firestore.collection("devices").doc(memberToken).get();
      if (deviceDoc.exists) {
        validTokens.push(memberToken);
      } else {
        console.log(`Skipping ${memberToken.substring(0, 10)}... - not in devices collection`);
      }
    }

    if (validTokens.length === 0) {
      return res.status(400).json({ error: "No valid device tokens found" });
    }

    console.log(`Sending FCM to ${validTokens.length} valid tokens:`, validTokens.map(t => t.substring(0, 10) + "..."));

    // Send FCM to all matching members
    const message = {
      tokens: validTokens,
      data: {
        title: "🔔 Knock Knock!",
        body: "Someone is at the door!",
        type: "knock",
        timestamp: new Date().toISOString(),
      },
      android: { priority: "high" },
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ FCM Response: Success: ${response.successCount}, Failure: ${response.failureCount}`);
    
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`FCM failed for ${validTokens[idx].substring(0, 10)}...:`, resp.error);
        }
      });
    }

    res.json({ 
      success: true, 
      count: validTokens.length, 
      fcmSuccess: response.successCount,
      fcmFailure: response.failureCount,
      message: "Knock delivered" 
    });
  } catch (err) {
    console.error("Send knock error:", err);
    res.status(500).json({ error: err.message });
  }
});
