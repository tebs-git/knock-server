const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.PROJECT_ID,
    clientEmail: process.env.CLIENT_EMAIL,
    privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const firestore = admin.firestore();
const app = express();

/**
 * IMPORTANT:
 * Must be here, immediately after app creation
 */
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());

/**
 * ===========================
 * AUTH HELPERS (FIX #2)
 * ===========================
 */
async function requireAuth(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) {
    throw new Error("Missing Authorization header");
  }
  const decoded = await admin.auth().verifyIdToken(match[1]);
  return decoded.uid;
}

/**
 * ===========================
 * IN-MEMORY KNOCK TRACKING
 * ===========================
 */
const pendingKnocks = new Map();

/**
 * ===========================
 * IP UTILITY
 * ===========================
 */
function getCompletePublicIp(req) {
  let ip = req.headers["x-forwarded-for"];
  if (ip) {
    const ipChain = ip.split(",").map(i => i.trim());
    return ipChain[0].replace(/^::ffff:/, "");
  }
  ip = req.ip || req.connection?.remoteAddress || "unknown";
  return ip.replace(/^::ffff:/, "");
}

/**
 * ===========================
 * USER ACTIVE GROUP (UID BASED)
 * ===========================
 */
async function setUserActiveGroup(uid, groupCode) {
  await firestore.collection("user_preferences").doc(uid).set(
    {
      active_group: groupCode,
      last_updated: new Date().toISOString(),
    },
    { merge: true }
  );
}

async function getUserActiveGroup(uid) {
  const doc = await firestore.collection("user_preferences").doc(uid).get();
  if (!doc.exists) return null;
  return doc.data().active_group || null;
}

/**
 * ===========================
 * DEVICE TOKEN REGISTRY
 * ===========================
 */
async function getUserFcmTokens(uid) {
  const snap = await firestore
    .collection("user_devices")
    .doc(uid)
    .collection("tokens")
    .get();
  return snap.docs.map(d => d.id);
}

app.post("/register-device", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const { fcmToken } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ error: "fcmToken required" });
    }

    await firestore
      .collection("user_devices")
      .doc(uid)
      .collection("tokens")
      .doc(fcmToken)
      .set({ updatedAt: Date.now() }, { merge: true });

    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * ===========================
 * HEALTH
 * ===========================
 */
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/**
 * ===========================
 * GROUP MANAGEMENT (UID BASED)
 * ===========================
 */
app.post("/create-group", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const { groupName } = req.body;
    if (!groupName) {
      return res.status(400).json({ error: "groupName required" });
    }

    const groupCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    await firestore.collection("groups").doc(groupCode).set({
      name: groupName,
      code: groupCode,
      createdAt: Date.now(),
      members: {
        [uid]: { joinedAt: Date.now() },
      },
    });

    await setUserActiveGroup(uid, groupCode);

    res.json({ success: true, groupCode, groupName, is_active: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/join-group", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const { groupCode } = req.body;
    if (!groupCode) {
      return res.status(400).json({ error: "groupCode required" });
    }

    const clean = groupCode.toUpperCase();
    const ref = firestore.collection("groups").doc(clean);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Group not found" });
    }

    await ref.update({
      [`members.${uid}`]: { joinedAt: Date.now() },
    });

    await setUserActiveGroup(uid, clean);

    res.json({ success: true, groupCode: clean, groupName: doc.data().name, is_active: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/my-groups", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    let activeGroup = await getUserActiveGroup(uid);

    const snap = await firestore.collection("groups").get();
    const groups = [];
    const codes = [];

    snap.forEach(doc => {
      const data = doc.data();
      if (data.members && data.members[uid]) {
        codes.push(doc.id);
        groups.push({
          groupCode: doc.id,
          groupName: data.name,
          memberCount: Object.keys(data.members).length,
          is_active: doc.id === activeGroup,
        });
      }
    });

    if (!activeGroup && groups.length > 0) {
      activeGroup = codes[0];
      await setUserActiveGroup(uid, activeGroup);
      groups.forEach(g => g.is_active = g.groupCode === activeGroup);
    }

    res.json({ success: true, groups, active_group: activeGroup });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/set-active-group", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const { groupCode } = req.body;

    const clean = groupCode.toUpperCase();
    const ref = firestore.collection("groups").doc(clean);
    const doc = await ref.get();

    if (!doc.exists || !doc.data().members[uid]) {
      return res.status(403).json({ error: "Not a member" });
    }

    await setUserActiveGroup(uid, clean);
    res.json({ success: true, groupCode: clean, groupName: doc.data().name });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/get-active-group", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const code = await getUserActiveGroup(uid);
    if (!code) return res.json({ success: true, has_active_group: false });

    const doc = await firestore.collection("groups").doc(code).get();
    if (!doc.exists) return res.json({ success: true, has_active_group: false });

    res.json({ success: true, has_active_group: true, groupCode: code, groupName: doc.data().name });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * ===========================
 * KNOCK FLOW (UNCHANGED LOGIC)
 * ===========================
 */
app.post("/knock-attempt", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const groupCode = req.body.groupCode || await getUserActiveGroup(uid);
    if (!groupCode) return res.status(400).json({ error: "No active group" });

    const senderIp = getCompletePublicIp(req);
    const clean = groupCode.toUpperCase();
    const doc = await firestore.collection("groups").doc(clean).get();
    if (!doc.exists || !doc.data().members[uid]) {
      return res.status(403).json({ error: "Not a member" });
    }

    const knockId = Date.now().toString();
    pendingKnocks.set(knockId, { senderUid: uid, senderIp, groupCode: clean });

    setTimeout(() => pendingKnocks.delete(knockId), 20000);

    for (const memberUid of Object.keys(doc.data().members)) {
      if (memberUid === uid) continue;
      const tokens = await getUserFcmTokens(memberUid);
      for (const t of tokens) {
        await admin.messaging().send({
          token: t,
          data: {
            type: "knock-attempt",
            knockId,
            title: "🔍 Knock Attempt",
            body: "Someone is checking if you're home...",
          },
          android: { priority: "high", notification: { sound: null } },
        });
      }
    }

    res.json({ success: true, knockId });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post("/report-ip", async (req, res) => {
  try {
    const uid = await requireAuth(req);
    const { knockId } = req.body;
    const receiverIp = getCompletePublicIp(req);

    const data = pendingKnocks.get(knockId);
    if (!data) return res.status(404).json({ error: "Knock expired" });

    if (receiverIp === data.senderIp) {
      const tokens = await getUserFcmTokens(uid);
      for (const t of tokens) {
        await admin.messaging().send({
          token: t,
          data: {
            type: "actual-knock",
            title: "🚪 Door Knock!",
            body: "Someone is at your door!",
          },
          android: { priority: "high" },
        });
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * ===========================
 * START SERVER
 * ===========================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
