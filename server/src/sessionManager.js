const { getDB } = require('./db');

async function createSession(sessionId) {
  const db = getDB();
  if (!db) {
    console.log('[Session] No DB, creating in-memory session:', sessionId?.slice(0, 8));
    return { sessionId, tvConnected: true, mobileConnected: false, createdAt: new Date() };
  }

  const session = {
    sessionId,
    tvConnected: true,
    mobileConnected: false,
    createdAt: new Date(),
    active: true,
  };

  await db.collection('sessions').updateOne(
    { sessionId },
    { $set: session },
    { upsert: true }
  );

  return session;
}

async function joinSession(sessionId) {
  const db = getDB();
  if (!db) return null;

  return db.collection('sessions').updateOne(
    { sessionId },
    { $set: { mobileConnected: true } }
  );
}

async function getSession(sessionId) {
  const db = getDB();
  if (!db) return { sessionId, exists: true };

  return db.collection('sessions').findOne({ sessionId });
}

async function endSession(sessionId) {
  const db = getDB();
  if (!db) return;

  // Mark session inactive
  await db.collection('sessions').updateOne(
    { sessionId },
    { $set: { active: false, endedAt: new Date() } }
  );

  // Remove streams for this session
  await db.collection('streams').deleteMany({ sessionId });
}

async function cleanupExpiredSessions() {
  const db = getDB();
  if (!db) return;

  const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
  const result = await db.collection('sessions').deleteMany({
    createdAt: { $lt: cutoff },
    active: { $ne: true },
  });

  if (result.deletedCount > 0) {
    console.log('[Cleanup] Removed', result.deletedCount, 'expired sessions');
  }
}

module.exports = {
  createSession,
  joinSession,
  getSession,
  endSession,
  cleanupExpiredSessions,
};
