require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { connectDB } = require('./db');
const { handleConnection } = require('./wsServer');
const { cleanupExpiredSessions } = require('./sessionManager');

const PORT = process.env.PORT || 8080;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', name: 'HubPlayer Server', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

// WebSocket
wss.on('connection', (ws, req) => {
  console.log('[WS] New connection from:', req.socket.remoteAddress);
  handleConnection(ws);
});

// Cleanup expired sessions every 10 minutes
setInterval(cleanupExpiredSessions, 10 * 60 * 1000);

// Start
async function start() {
  try {
    await connectDB();
    console.log('[DB] Connected to MongoDB');
  } catch (err) {
    console.error('[DB] Failed to connect:', err.message);
    console.log('[DB] Continuing without database...');
  }

  server.listen(PORT, () => {
    console.log(`[Server] HubPlayer running on port ${PORT}`);
    console.log(`[Server] Health: http://localhost:${PORT}/health`);
  });
}

start();
