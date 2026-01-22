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

// Important for Render / proxies so req.ip works
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());

/**
 * In-memory store of short-lived knocks
 * knockId -> { senderUid, senderIp, groupCode, timestamp }
 */
const pendingKnocks = new Map();
const KNOCK_TTL_MS = 20_000;
const ACTUAL_KNOCK_DELAY_MS = 2000;

/* ----------------------------- Helpers ----------------------------- */

function getCompletePublicIp(req) {
  let ip = req.headers["x-forwarded-for"];
  if (ip) {
    const first = ip.split(",")[0].trim();
    return first.replace(/^::ffff:/, "");
  }
  ip =
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    "unknown";
  return String(ip).replace(/^::ffff:/, "");
}

function ok(res, obj) {
  res.json(obj);
}

function fail(res, status, msg) {
  res.status(status).json({ error: msg });
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return fail(res, 401, "Missing Authorization: Bearer <ID_TOKEN>");

    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    return fail(res, 401, "Invalid auth token");
  }
}

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
  return doc.data()?.active_group || null;
}

async function getGroupDoc(groupCode) {
  const clean = String(groupCode).toUpperCase();
  const ref = firestore.collection("groups").doc(clean);
  const doc = await ref.get();
  return { clean, ref, doc };
}

function isMember(groupData, uid) {
  return !!(groupData?.members && groupData.members[uid]);
}

/**
 * Stores device token under user_devices/{uid}/tokens.{fcmToken}
 * (Using object map so you don’t need subcollections)
 */
async function upsertDeviceToken(uid, fcmToken) {
  const ref = firestore.collection("user_devices").doc(uid);
  await ref.set(
    {
      updatedAt: Date.now(),
      tokens: {
        [fcmToken]: { updatedAt: Date.now() },
      },
    },
    { merge: true }
  );
}

async function getUserDeviceTokens(uid) {
  const doc = await firestore.collection("user_devices").doc(uid).get();
  if (!doc.exists) return [];
  const data = doc.data() || {};
  const tokensObj = data.tokens || {};
  return Object.keys(tokensObj);
}

async function sendToUserAllDevices(uid, message) {
  const tokens = await getUserDeviceTokens(uid);
  if (tokens.length === 0) return 0;

  const sends = tokens.map((t) => admin.messaging().send({ token: t, ...message }));
  await Promise.allSettled(sends);
  return tokens.length;
}

function createKnock(knockId, senderUid, senderIp, groupCode) {
  const data = {
    knockId,
    senderUid,
    senderIp,
    groupCode,
    timestamp: Date.now(),
  };

  pendingKnocks.set(knockId, data);

  setTimeout(() => {
    pendingKnocks.delete(knockId);
  }, KNOCK_TTL_MS);

  return data;
}

/* ------------------------------ Routes ------------------------------ */

app.get("/health", (req, res) => ok(res, { status: "OK" }));

/**
 * register-device
 * body: { token } OR { fcmToken }
 */
app.post("/register-device", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const fcmToken = req.body.fcmToken || req.body.token;
    if (!fcmToken) return fail(res, 400, "token (FCM token) required");

    await upsertDeviceToken(uid, fcmToken);
    ok(res, { success: true });
  } catch (e) {
    console.error("Register device error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/create-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupName } = req.body;
    if (!groupName) return fail(res, 400, "groupName required");

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

    ok(res, { success: true, groupCode, groupName, is_active: true });
  } catch (e) {
    console.error("Create group error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/join-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupCode } = req.body;
    if (!groupCode) return fail(res, 400, "groupCode required");

    const { clean, ref, doc } = await getGroupDoc(groupCode);
    if (!doc.exists) return fail(res, 404, "Group not found");

    await ref.update({ [`members.${uid}`]: { joinedAt: Date.now() } });
    await setUserActiveGroup(uid, clean);

    ok(res, {
      success: true,
      groupName: doc.data().name,
      groupCode: clean,
      is_active: true,
    });
  } catch (e) {
    console.error("Join group error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/my-groups", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    let activeGroup = await getUserActiveGroup(uid);

    const groupsSnapshot = await firestore.collection("groups").get();
    const userGroups = [];
    const userGroupCodes = [];

    groupsSnapshot.forEach((d) => {
      const data = d.data();
      if (data.members && data.members[uid]) {
        userGroupCodes.push(d.id);
        userGroups.push({
          groupCode: d.id,
          groupName: data.name,
          memberCount: Object.keys(data.members).length,
          is_active: d.id === activeGroup,
        });
      }
    });

    // If user has groups but no active one set, pick first
    if (userGroups.length > 0 && !activeGroup) {
      activeGroup = userGroupCodes[0];
      await setUserActiveGroup(uid, activeGroup);
      userGroups.forEach((g) => (g.is_active = g.groupCode === activeGroup));
    }

    ok(res, { success: true, groups: userGroups, active_group: activeGroup });
  } catch (e) {
    console.error("My groups error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/set-active-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupCode } = req.body;
    if (!groupCode) return fail(res, 400, "groupCode required");

    const { clean, doc } = await getGroupDoc(groupCode);
    if (!doc.exists) return fail(res, 404, "Group not found");

    const data = doc.data();
    if (!isMember(data, uid)) return fail(res, 403, "Not a member");

    await setUserActiveGroup(uid, clean);
    ok(res, { success: true, groupCode: clean, groupName: data.name });
  } catch (e) {
    console.error("Set active group error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/get-active-group", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const activeGroupCode = await getUserActiveGroup(uid);

    if (!activeGroupCode) return ok(res, { success: true, has_active_group: false });

    const { doc } = await getGroupDoc(activeGroupCode);
    if (!doc.exists) {
      await firestore.collection("user_preferences").doc(uid).set(
        { active_group: null },
        { merge: true }
      );
      return ok(res, { success: true, has_active_group: false });
    }

    ok(res, {
      success: true,
      has_active_group: true,
      groupCode: activeGroupCode,
      groupName: doc.data().name,
    });
  } catch (e) {
    console.error("Get active group error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/knock-attempt", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { groupCode } = req.body;
    if (!groupCode) return fail(res, 400, "groupCode required");

    const senderIp = getCompletePublicIp(req);
    const { clean, doc } = await getGroupDoc(groupCode);
    if (!doc.exists) return fail(res, 404, "Group not found");

    const groupData = doc.data();
    if (!isMember(groupData, uid)) return fail(res, 403, "Not a member");

    const knockId = Date.now().toString();
    createKnock(knockId, uid, senderIp, clean);

    const receiverUids = Object.keys(groupData.members || {}).filter((m) => m !== uid);
    if (receiverUids.length === 0) {
      return fail(res, 400, "No one else in group");
    }

    const message = {
      data: {
        title: "🔍 Knock Attempt",
        body: "Someone is checking if you're home...",
        type: "knock-attempt",
        knockId,
        senderUid: uid,
      },
      android: {
        priority: "high",
        notification: { sound: null, defaultSound: false },
      },
    };

    // Send to all devices for each receiver UID
    const sends = receiverUids.map((ruid) => sendToUserAllDevices(ruid, message));
    await Promise.allSettled(sends);

    ok(res, {
      success: true,
      message: `Checking ${receiverUids.length} person(s)...`,
      knockId,
      count: receiverUids.length,
    });
  } catch (e) {
    console.error("Knock attempt error:", e);
    fail(res, 500, e.message);
  }
});

app.post("/report-ip", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { knockId } = req.body;
    if (!knockId) return fail(res, 400, "knockId required");

    const receiverIp = getCompletePublicIp(req);
    const pending = pendingKnocks.get(knockId);
    if (!pending) return fail(res, 404, "Knock attempt expired");

    // Verify membership for this knock’s group
    const { doc } = await getGroupDoc(pending.groupCode);
    if (!doc.exists) return fail(res, 404, "Group not found");
    if (!isMember(doc.data(), uid)) return fail(res, 403, "Not a member");

    const isSameNetwork = receiverIp === pending.senderIp;

    // Keep your delay behavior
    setTimeout(async () => {
      try {
        if (!isSameNetwork) return;
        if (!pendingKnocks.has(knockId)) return;

        const message = {
          data: {
            title: "🚪 Door Knock!",
            body: "Someone is at your door!",
            type: "actual-knock",
          },
          android: { priority: "high" },
        };

        await sendToUserAllDevices(uid, message);
      } catch (e) {
        console.error("Actual knock send error:", e);
      }
    }, ACTUAL_KNOCK_DELAY_MS);

    ok(res, { success: true, isSameNetwork });
  } catch (e) {
    console.error("Report IP error:", e);
    fail(res, 500, e.message);
  }
});

/* ----------------------------- Start ----------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
