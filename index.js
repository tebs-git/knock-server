// ✅ Create or update a group (one group per device)
app.post("/create-or-update-group", async (req, res) => {
  try {
    const { deviceId, groupName } = req.body;
    if (!deviceId || !groupName) {
      return res.status(400).json({ error: "deviceId and groupName are required" });
    }

    // Generate a consistent group ID based on device ID
    const groupId = `group_${deviceId}`;

    // First, remove this device from any other groups it might be in
    const allGroups = await firestore.collection("groups").get();
    const cleanupPromises = [];
    
    allGroups.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members.includes(deviceId) && doc.id !== groupId) {
        // Remove this device from other groups
        cleanupPromises.push(
          firestore.collection("groups").doc(doc.id).update({
            members: admin.firestore.FieldValue.arrayRemove(deviceId)
          })
        );
      }
    });

    await Promise.all(cleanupPromises);

    // Create or update the group
    await firestore.collection("groups").doc(groupId).set({
      adminDeviceId: deviceId,
      groupName,
      members: [deviceId], // Start with just the admin
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }, { merge: true }); // merge: true updates if exists, creates if not

    console.log(`Group created/updated: ${groupName} (${groupId}) by ${deviceId}`);
    res.json({ 
      success: true, 
      groupId, 
      groupName, 
      message: "Group created/updated",
      isNew: true 
    });
  } catch (err) {
    console.error("Error creating/updating group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Join a group (and leave previous groups)
app.post("/join-group", async (req, res) => {
  try {
    const { groupId, deviceId } = req.body;
    if (!groupId || !deviceId) {
      return res.status(400).json({ error: "groupId and deviceId are required" });
    }

    const groupRef = firestore.collection("groups").doc(groupId);
    const groupDoc = await groupRef.get();
    
    if (!groupDoc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    // First, remove this device from any other groups
    const allGroups = await firestore.collection("groups").get();
    const cleanupPromises = [];
    
    allGroups.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members.includes(deviceId) && doc.id !== groupId) {
        cleanupPromises.push(
          firestore.collection("groups").doc(doc.id).update({
            members: admin.firestore.FieldValue.arrayRemove(deviceId)
          })
        );
      }
    });

    await Promise.all(cleanupPromises);

    // Now add to the new group
    await groupRef.update({
      members: admin.firestore.FieldValue.arrayUnion(deviceId),
      lastUpdated: new Date().toISOString(),
    });

    console.log(`Device ${deviceId} joined group ${groupId}`);
    res.json({ success: true, message: "Joined group" });
  } catch (err) {
    console.error("Error joining group:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Clean up empty groups (optional - can run periodically)
app.post("/cleanup-groups", async (req, res) => {
  try {
    const groupsSnapshot = await firestore.collection("groups").get();
    const deletePromises = [];
    
    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (!groupData.members || groupData.members.length === 0) {
        deletePromises.push(firestore.collection("groups").doc(doc.id).delete());
      }
    });

    await Promise.all(deletePromises);
    console.log(`Cleaned up ${deletePromises.length} empty groups`);
    res.json({ success: true, deletedCount: deletePromises.length });
  } catch (err) {
    console.error("Error cleaning up groups:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Leave group
app.post("/leave-group", async (req, res) => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      return res.status(400).json({ error: "deviceId is required" });
    }

    const groupsSnapshot = await firestore.collection("groups").get();
    const leavePromises = [];
    
    groupsSnapshot.forEach(doc => {
      const groupData = doc.data();
      if (groupData.members && groupData.members.includes(deviceId)) {
        leavePromises.push(
          firestore.collection("groups").doc(doc.id).update({
            members: admin.firestore.FieldValue.arrayRemove(deviceId)
          })
        );
      }
    });

    await Promise.all(leavePromises);
    console.log(`Device ${deviceId} left all groups`);
    res.json({ success: true, message: "Left all groups" });
  } catch (err) {
    console.error("Error leaving groups:", err);
    res.status(500).json({ error: err.message });
  }
});
