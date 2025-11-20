// index.js
// Minimal WebSocket chat server that stores ciphertext messages in Supabase
// and broadcasts to connected participants in the same chat_id.

// Environment variables (see .env.example)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const app = express();
app.use(express.json());

// simple health route
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Map chat_id => Set of ws connections
const chatRooms = new Map();

// helper to authenticate a Supabase access token and get user info
// calls Supabase auth endpoint: /auth/v1/user
async function getUserFromToken(accessToken) {
  if (!accessToken) return null;
  try {
    const resp = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/auth/v1/user`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // data is user object { id, email, ...}
    return data;
  } catch (err) {
    console.error('Error verifying token:', err);
    return null;
  }
}

// Broadcast helper: send JSON to all sockets in that chat (except optional exclude)
function broadcastToChat(chatId, payload, excludeSocket = null) {
  const set = chatRooms.get(chatId);
  if (!set) return;
  const text = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN && ws !== excludeSocket) {
      ws.send(text);
    }
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  // connection state
  ws.user = null;
  ws.subscribedChats = new Set();

  // Expect the client to first send an "auth" message with their Supabase access token:
  // { type: 'auth', accessToken: '<supabase_access_token>' }
  // After auth, the client can send:
  // { type: 'subscribe', chat_id: 'dm:uid1:uid2' }
  // { type: 'message', chat_id, ciphertext, nonce, sender_pubkey, metadata }
  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }

    if (msg.type === 'auth') {
      const token = msg.accessToken;
      const user = await getUserFromToken(token);
      if (!user || !user.id) {
        ws.send(JSON.stringify({ type: 'auth', ok: false }));
        ws.close();
        return;
      }
      ws.user = { id: user.id, email: user.email || null };
      ws.send(JSON.stringify({ type: 'auth', ok: true, user: { id: ws.user.id } }));
      console.log('ws authenticated user', ws.user.id);
      return;
    }

    // require auth for other actions
    if (!ws.user) {
      ws.send(JSON.stringify({ type: 'error', error: 'not_authenticated' }));
      return;
    }

    if (msg.type === 'subscribe') {
      const chatId = msg.chat_id;
      if (!chatId) return;
      let set = chatRooms.get(chatId);
      if (!set) {
        set = new Set();
        chatRooms.set(chatId, set);
      }
      set.add(ws);
      ws.subscribedChats.add(chatId);
      ws.send(JSON.stringify({ type: 'subscribed', chat_id: chatId }));
      return;
    }

    if (msg.type === 'unsubscribe') {
      const chatId = msg.chat_id;
      if (!chatId) return;
      const set = chatRooms.get(chatId);
      if (set) set.delete(ws);
      ws.subscribedChats.delete(chatId);
      ws.send(JSON.stringify({ type: 'unsubscribed', chat_id: chatId }));
      return;
    }

    if (msg.type === 'message') {
      // Validate fields
      const { chat_id, ciphertext, nonce, sender_pubkey, metadata } = msg;
      if (!chat_id || !ciphertext) {
        ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' }));
        return;
      }
      // Ensure the sender (from token) equals the claimed sender (we enforce via RLS on DB)
      const payload = {
        chat_id,
        sender: ws.user.id,
        ciphertext,
        nonce: nonce || null,
        sender_pubkey: sender_pubkey || null,
        metadata: metadata || {}
      };

      try {
        // Insert into Supabase messages table using service role
        const r = await supabase.from('messages').insert(payload).select().single();
        if (r.error) {
          console.error('supabase insert error', r.error);
          ws.send(JSON.stringify({ type: 'error', error: 'db_insert_failed', detail: r.error.message }));
          return;
        }
        const inserted = r.data;
        // Broadcast to other sockets in the chat
        const out = {
          type: 'message',
          id: inserted.id,
          chat_id: inserted.chat_id,
          sender: inserted.sender,
          ciphertext: inserted.ciphertext,
          nonce: inserted.nonce,
          sender_pubkey: inserted.sender_pubkey,
          metadata: inserted.metadata,
          created_at: inserted.created_at
        };
        broadcastToChat(chat_id, out, null); // send to all (including sender)
      } catch (err) {
        console.error('Insert exception', err);
        ws.send(JSON.stringify({ type: 'error', error: 'server_error' }));
      }
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' }));
  });

  ws.on('close', () => {
    // cleanup from chatRooms
    for (const chatId of ws.subscribedChats) {
      const set = chatRooms.get(chatId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) chatRooms.delete(chatId);
      }
    }
  });
});

// heartbeat to drop dead sockets
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

// graceful shutdown
process.on('SIGINT', () => {
  console.log('SIGINT: shutting down');
  clearInterval(interval);
  wss.close(() => process.exit(0));
});