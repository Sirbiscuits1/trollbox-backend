const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// In-memory storage
const boards = [
  { id: 'b', name: 'Random', description: 'Random discussion' },
  { id: 'biz', name: 'Business', description: 'Business and finance' },
  { id: 'pol', name: 'Politics', description: 'Political discussion' },
  { id: 'crypto', name: 'Crypto', description: 'Cryptocurrency talk' },
  { id: 'tech', name: 'Technology', description: 'Tech discussion' },
  { id: 'memes', name: 'Memes', description: 'Memes and jokes' }
];

const users = new Map();                    // username → user object (stable ID per username)
const messages = new Map();                 // boardId → array of messages
const boardUsers = new Map();               // boardId → Set of userInfo
const bannedIPs = new Set();                // Banned IPs
const messageTimestamps = new Map();        // socket.id → array of timestamps (spam detection)

// CHANGE THIS TO YOUR USER ID AFTER FIRST LOGIN (it will stay the same forever now)
const MOD_USER_ID = null; // e.g., 7

// Fixed seed for deterministic ID generation
function generateUserId(username) {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    const char = username.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) + 1; // Positive ID starting from 1
}

// API Routes
app.get('/api/boards', (req, res) => res.json(boards));

app.get('/api/boards/:boardId/messages', (req, res) => {
  const { boardId } = req.params;
  const boardMessages = messages.get(boardId) || [];
  res.json(boardMessages.slice(-100));
});

app.post('/api/users', (req, res) => {
  let { username } = req.body;
  if (!username || username.trim() === '') {
    return res.status(400).json({ error: 'Username required' });
  }

  username = username.trim().substring(0, 20);
  if (username.length < 1) username = 'Anonymous';

  // Check if user already exists — if so, return existing
  for (const user of users.values()) {
    if (user.username.toLowerCase() === username.toLowerCase()) {
      return res.json(user);
    }
  }

  // New user — generate stable ID from username
  const id = generateUserId(username);
  const avatar = username.substring(0, 2).toUpperCase() || 'AN';
  const user = { id, username, avatar };

  users.set(username.toLowerCase(), user); // key by lowercase for case-insensitive lookup
  console.log(`New user registered: ${username} (stable ID: ${id})`);
  res.json(user);
});

// Socket Events
io.on('connection', (socket) => {
  const clientIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address;
  console.log('Client connected:', socket.id, 'IP:', clientIP);

  console.log('=== 4CHAIN BACKEND RUNNING - STABLE USER IDs, MOD TOOLS ACTIVE ===');

  if (bannedIPs.has(clientIP)) {
    console.log('Banned IP connected:', clientIP);
    socket.emit('error', { message: 'You are banned from this chat.' });
    socket.disconnect(true);
    return;
  }

  messageTimestamps.set(socket.id, []);

  socket.on('join_board', ({ boardId, user }) => {
    if (!user || !user.id) return;

    socket.join(boardId);

    if (!boardUsers.has(boardId)) boardUsers.set(boardId, new Set());

    const userInfo = {
      socketId: socket.id,
      userId: user.id,
      username: user.username,
      avatar: user.avatar
    };

    boardUsers.get(boardId).add(userInfo);

    const onlineUsers = Array.from(boardUsers.get(boardId)).map(u => ({
      userId: u.userId,
      username: u.username,
      avatar: u.avatar
    }));

    io.to(boardId).emit('online_users_update', {
      boardId,
      users: onlineUsers,
      count: onlineUsers.length
    });

    io.to(boardId).emit('user_count_update', { boardId, count: onlineUsers.length });

    console.log(`${user.username} (ID: ${user.id}) joined /${boardId}/`);
  });

  socket.on('send_message', ({ boardId, message, userId: messageUserId }) => {
    const timestamps = messageTimestamps.get(socket.id);
    timestamps.push(Date.now());
    while (timestamps.length && timestamps[0] < Date.now() - 30000) timestamps.shift();

    if (timestamps.length > 10) {
      bannedIPs.add(clientIP);
      console.log('AUTO-BANNED SPAMMER IP:', clientIP);
      socket.emit('error', { message: 'Banned for spamming.' });
      socket.disconnect(true);
      return;
    }

    // Find user by ID
    let user = null;
    for (const u of users.values()) {
      if (u.id === messageUserId) {
        user = u;
        break;
      }
    }
    if (!user) {
      socket.emit('error', { message: 'Invalid user' });
      return;
    }

    const trimmed = message.trim();
    if (trimmed === '') return;

    // Moderator commands
    if (messageUserId === MOD_USER_ID) {
      if (trimmed.startsWith('/banip ')) {
        const ip = trimmed.slice(7).trim();
        bannedIPs.add(ip);
        console.log(`MOD BANNED IP: ${ip}`);
        socket.emit('notice', { message: `Banned IP ${ip}` });
        return;
      }

      if (trimmed.startsWith('/ban @')) {
        const target = trimmed.slice(6).trim();
        boardUsers.forEach((set, bid) => {
          set.forEach(u => {
            if (u.username === target) {
              const targetIP = u.socketId === socket.id ? clientIP : 'unknown';
              bannedIPs.add(targetIP);
              io.sockets.sockets.get(u.socketId)?.disconnect(true);
              console.log(`MOD BANNED USER: ${target} (IP: ${targetIP})`);
            }
          });
        });
        socket.emit('notice', { message: `Banned user @${target}` });
        return;
      }
    }

    const messageId = Date.now() + Math.random();
    const messageData = {
      id: messageId,
      board_id: boardId,
      user_id: user.id,
      username: user.username,
      avatar: user.avatar,
      message: trimmed,
      timestamp: new Date().toISOString()
    };

    const boardMessages = messages.get(boardId) || [];
    boardMessages.push(messageData);
    if (boardMessages.length > 1000) boardMessages.shift();
    messages.set(boardId, boardMessages);

    io.to(boardId).emit('new_message', messageData);

    console.log(`Message from ${user.username} (ID: ${user.id}) in /${boardId}/: ${trimmed}`);

    if (/based/i.test(trimmed)) {
      io.to(boardId).emit('confetti_trigger', { messageId });
      console.log('Confetti triggered for "based"');
    }
  });

  socket.on('disconnect', () => {
    messageTimestamps.delete(socket.id);

    boardUsers.forEach((set, boardId) => {
      let removed = null;
      set.forEach(u => {
        if (u.socketId === socket.id) {
          removed = u;
          set.delete(u);
        }
      });

      if (removed) {
        const onlineUsers = Array.from(set).map(u => ({
          userId: u.userId,
          username: u.username,
          avatar: u.avatar
        }));

        io.to(boardId).emit('online_users_update', {
          boardId,
          users: onlineUsers,
          count: onlineUsers.length
        });

        io.to(boardId).emit('user_count_update', { boardId, count: onlineUsers.length });

        console.log(`${removed.username} (ID: ${removed.userId}) disconnected`);
      }
    });

    console.log('Client disconnected:', socket.id);
  });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 4chain backend with stable user IDs & moderation running on port ${PORT}`);
});