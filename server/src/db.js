const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.DB_NAME || 'hubplayer';

let client = null;
let db = null;

async function connectDB() {
  if (!uri) {
    throw new Error('MONGODB_URI not set in environment');
  }

  client = new MongoClient(uri, {
    maxPoolSize: 10,
    serverApi: { version: '1', strict: true, deprecationErrors: true },
  });

  await client.connect();
  db = client.db(dbName);

  // Create indexes
  await db.collection('sessions').createIndex({ sessionId: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
  await db.collection('streams').createIndex({ sessionId: 1 });

  console.log('[DB] Connected to:', dbName);
  return db;
}

function getDB() {
  return db;
}

function getClient() {
  return client;
}

module.exports = { connectDB, getDB, getClient };
