const { v4: uuidv4 } = require('uuid');
const { getDB } = require('./db');
const { createSession, joinSession, endSession, getSession } = require('./sessionManager');

// Track active connections: sessionId -> { tv: ws, mobile: ws }
const sessions = new Map();

function handleConnection(ws) {
  console.log('[WS] Client connected');

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('[WS] Received:', msg.type, msg.sessionId?.slice(0, 8) || '');

      switch (msg.type) {
        case 'tv_connect':
          await handleTVConnect(ws, msg);
          break;
        case 'mobile_connect':
          await handleMobileConnect(ws, msg);
          break;
        case 'add_stream':
          await handleAddStream(ws, msg);
          break;
        case 'remove_stream':
          await handleRemoveStream(ws, msg);
          break;
        case 'play':
          await handlePlay(ws, msg);
          break;
        case 'pause':
          await forwardToTV(ws, msg);
          break;
        case 'resume':
          await forwardToTV(ws, msg);
          break;
        case 'seek':
          await forwardToTV(ws, msg);
          break;
        case 'stop':
          await forwardToTV(ws, msg);
          break;
        case 'playback_update':
          await forwardToMobile(ws, msg);
          break;
        case 'request_playlist':
          await sendPlaylist(ws, msg.sessionId);
          break;
        case 'disconnect':
          await handleDisconnect(ws, msg);
          break;
        default:
          sendTo(ws, { type: 'error', message: 'Unknown message type: ' + msg.type });
      }
    } catch (err) {
      console.error('[WS] Error processing message:', err.message);
      sendTo(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', async () => {
    console.log('[WS] Client disconnected');
    await cleanupDisconnectedClient(ws);
  });

  ws.on('error', (err) => {
    console.error('[WS] Connection error:', err.message);
  });
}

// --- TV Handlers ---

async function handleTVConnect(ws, msg) {
  const sessionId = msg.sessionId || uuidv4();

  // Create or get session
  const session = await createSession(sessionId);

  // Store connection
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { tv: null, mobile: null, playlist: [] });
  }
  const room = sessions.get(sessionId);
  room.tv = ws;

  // Attach session info to ws
  ws.sessionId = sessionId;
  ws.role = 'tv';

  console.log('[TV] Connected to session:', sessionId.slice(0, 8));

  // Send session confirmation
  sendTo(ws, { type: 'session_created', sessionId });

  // Check if mobile already connected
  if (room.mobile) {
    sendTo(ws, { type: 'paired' });
    sendTo(room.mobile, { type: 'paired' });
    await sendPlaylistToAll(sessionId);
  }
}

// --- Mobile Handlers ---

async function handleMobileConnect(ws, msg) {
  const { sessionId } = msg;

  if (!sessionId) {
    sendTo(ws, { type: 'error', message: 'sessionId is required' });
    return;
  }

  // Check session exists
  const session = await getSession(sessionId);
  if (!session) {
    sendTo(ws, { type: 'error', message: 'Session not found. Scan QR code on TV first.' });
    return;
  }

  // Join session
  await joinSession(sessionId);

  // Store connection
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { tv: null, mobile: null, playlist: [] });
  }
  const room = sessions.get(sessionId);
  room.mobile = ws;

  ws.sessionId = sessionId;
  ws.role = 'mobile';

  console.log('[Mobile] Connected to session:', sessionId.slice(0, 8));

  // Notify both
  sendTo(ws, { type: 'paired' });
  if (room.tv) {
    sendTo(room.tv, { type: 'paired' });
  }

  await sendPlaylistToAll(sessionId);
}

// --- Stream Management ---

async function handleAddStream(ws, msg) {
  const { sessionId, name, url } = msg;

  if (!name || !url) {
    sendTo(ws, { type: 'error', message: 'Name and URL are required' });
    return;
  }

  const db = getDB();
  const stream = {
    sessionId: sessionId || ws.sessionId,
    name: name.trim(),
    url: url.trim(),
    addedAt: new Date(),
    playedAt: null,
  };

  let result;
  if (db) {
    result = await db.collection('streams').insertOne(stream);
    stream._id = result.insertedId;
  } else {
    stream._id = uuidv4();
    const room = sessions.get(sessionId || ws.sessionId);
    if (room) room.playlist = room.playlist || [];
    room.playlist.push(stream);
  }

  console.log('[Stream] Added:', name, '->', url.slice(0, 40));

  await sendPlaylistToAll(sessionId || ws.sessionId);
}

async function handleRemoveStream(ws, msg) {
  const { sessionId, streamId } = msg;
  const sid = sessionId || ws.sessionId;

  const db = getDB();
  if (db) {
    const { ObjectId } = require('mongodb');
    await db.collection('streams').deleteOne({ _id: new ObjectId(streamId) });
  } else {
    const room = sessions.get(sid);
    if (room) {
      room.playlist = (room.playlist || []).filter(s => s._id !== streamId);
    }
  }

  console.log('[Stream] Removed:', streamId);
  await sendPlaylistToAll(sid);
}

// --- Playback ---

async function handlePlay(ws, msg) {
  const { sessionId, streamId, url, name } = msg;
  const sid = sessionId || ws.sessionId;

  const room = sessions.get(sid);
  if (!room || !room.tv) {
    sendTo(ws, { type: 'error', message: 'TV is not connected' });
    return;
  }

  let playUrl = url;
  let playName = name;

  // If streamId provided, look it up
  if (streamId && !url) {
    const db = getDB();
    if (db) {
      const { ObjectId } = require('mongodb');
      const stream = await db.collection('streams').findOne({ _id: new ObjectId(streamId) });
      if (stream) {
        playUrl = stream.url;
        playName = stream.name;
        await db.collection('streams').updateOne(
          { _id: new ObjectId(streamId) },
          { $set: { playedAt: new Date() } }
        );
      }
    } else {
      const stream = (room.playlist || []).find(s => s._id === streamId);
      if (stream) {
        playUrl = stream.url;
        playName = stream.name;
        stream.playedAt = new Date();
      }
    }
  }

  console.log('[Play] Sending to TV:', playName, '->', playUrl?.slice(0, 40));

  sendTo(room.tv, {
    type: 'play',
    url: playUrl,
    name: playName,
  });

  sendTo(ws, {
    type: 'playback_state',
    state: 'loading',
    name: playName,
  });
}

async function forwardToTV(ws, msg) {
  const sid = ws.sessionId;
  const room = sessions.get(sid);
  if (room && room.tv) {
    sendTo(room.tv, msg);
  }
}

async function forwardToMobile(ws, msg) {
  const sid = ws.sessionId;
  const room = sessions.get(sid);
  if (room && room.mobile) {
    sendTo(room.mobile, msg);
  }
}

// --- Playlist ---

async function sendPlaylist(sessionId) {
  const room = sessions.get(sessionId);
  if (!room) return;

  const db = getDB();
  let streams = [];

  if (db) {
    streams = await db.collection('streams')
      .find({ sessionId })
      .sort({ addedAt: -1 })
      .toArray();
  } else {
    streams = room.playlist || [];
  }

  const sanitized = streams.map(s => ({
    _id: s._id?.toString() || s._id,
    name: s.name,
    url: s.url,
    addedAt: s.addedAt,
    playedAt: s.playedAt,
  }));

  const msg = { type: 'playlist_updated', streams: sanitized };

  if (room.tv) sendTo(room.tv, msg);
  if (room.mobile) sendTo(room.mobile, msg);
}

async function sendPlaylistToAll(sessionId) {
  await sendPlaylist(sessionId);
}

// --- Disconnect ---

async function handleDisconnect(ws, msg) {
  const sid = msg.sessionId || ws.sessionId;
  await endSession(sid);
  sessions.delete(sid);
  console.log('[Session] Ended:', sid?.slice(0, 8));
}

async function cleanupDisconnectedClient(ws) {
  const sid = ws.sessionId;
  if (!sid) return;

  const room = sessions.get(sid);
  if (!room) return;

  if (ws.role === 'tv') {
    room.tv = null;
    if (room.mobile) {
      sendTo(room.mobile, { type: 'tv_disconnected' });
    }
  } else if (ws.role === 'mobile') {
    room.mobile = null;
    if (room.tv) {
      sendTo(room.tv, { type: 'mobile_disconnected' });
    }
  }

  // If both disconnected, clean up
  if (!room.tv && !room.mobile) {
    await endSession(sid);
    sessions.delete(sid);
    console.log('[Session] Cleaned up (both disconnected):', sid.slice(0, 8));
  }
}

// --- Helpers ---

function sendTo(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

module.exports = { handleConnection };
