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

const users = new Map();                    // userId → user object
const messages = new Map();                 // boardId → array of messages
const boardUsers = new Map();               // boardId → Set of userInfo
const bannedIPs = new Set();                // Banned IPs
const messageTimestamps = new Map();        // socket.id → array of timestamps (spam detection)
const reactions = new Map();                // messageId → Map(emoji → Set(userId))

// CHANGE THIS TO YOUR USER ID AFTER FIRST LOGIN (check server logs)
const MOD_USER_ID = null; // e.g., 7

// Initialize
let userIdCounter = 1;
users.set(userIdCounter, { id: userIdCounter, username: 'Anonymous', avatar: 'AN' });

boards.forEach(board => {
  messages.set(board.id, []);
});

// API Routes
app.get('/api/boards', (req, res) => res.json(boards));

app.get('/api/boards/:boardId/messages', (req, res) => {
  const { boardId } = req.params;
  const boardMessages = messages.get(boardId) || [];
  res.json(boardMessages.slice(-100));
});

app.post('/api/users', (req, res) => {
  const { username } = req.body;
  if (!username || username.trim() === '') {
    return res.status(400).json({ error: 'Username required' });
  }
  userIdCounter++;
  const trimmed = username.trim().substring(0, 20);
  const avatar = trimmed.substring(0, 2).toUpperCase() || 'AN';
  const user = { id: userIdCounter, username: trimmed, avatar };
  users.set(userIdCounter, user);
  res.json(user);
});

// Socket Events
io.on('connection', (socket) => {
  // Get real client IP (important for banning on Render)
  const clientIP = socket.handshake.headers['x-forwarded-for']?.split(',')[0].trim() || socket.handshake.address;
  console.log('Client connected:', socket.id, 'IP:', clientIP);

  // Startup test log to confirm new version is running
  console.log('=== 4CHAIN BACKEND NEW VERSION LOADED - MOD TOOLS, CONFETTI & REACTIONS ACTIVE ===');

  if (bannedIPs.has(clientIP)) {
    console.log('Banned IP tried to connect:', clientIP);
    socket.emit('error', { message: 'You are banned from this chat.' });
    socket.disconnect(true);
    return;
  }

  messageTimestamps.set(socket.id, []);

  socket.on('join_board', ({ boardId, user }) => {
    if (!user || !users.has(user.id)) {
      console.warn('Invalid user attempting to join board:', user);
      return;
    }

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

    console.log(`${user.username} (ID: ${user.id}) joined /${boardId}/ (online: ${onlineUsers.length})`);
  });

  socket.on('leave_board', (boardId) => {
    if (!boardUsers.has(boardId)) return;

    const usersSet = boardUsers.get(boardId);
    let removedUser = null;

    for (const userInfo of usersSet) {
      if (userInfo.socketId === socket.id) {
        removedUser = userInfo;
        usersSet.delete(userInfo);
        break;
      }
    }

    if (removedUser) {
      const onlineUsers = Array.from(usersSet).map(u => ({
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

      console.log(`${removedUser.username} left /${boardId}/ (online: ${onlineUsers.length})`);
    }

    socket.leave(boardId);
  });

  socket.on('send_message', ({ boardId, message, userId: messageUserId }) => {
    const timestamps = messageTimestamps.get(socket.id);
    timestamps.push(Date.now());
    while (timestamps.length && timestamps[0] < Date.now() - 30000) timestamps.shift();

    if (timestamps.length > 10) {
      bannedIPs.add(clientIP);
      console.log('AUTO-BANNED SPAMMER:', clientIP);
      socket.emit('error', { message: 'Banned for spamming.' });
      socket.disconnect(true);
      return;
    }

    const user = users.get(messageUserId) || users.get(1);
    if (!user) {
      socket.emit('error', { message: 'Invalid user' });
      return;
    }

    const trimmedMessage = message.trim();
    if (trimmedMessage === '') return;

    // Moderator commands
    if (messageUserId === MOD_USER_ID) {
      if (trimmedMessage.startsWith('/banip ')) {
        const ip = trimmedMessage.slice(7).trim();
        bannedIPs.add(ip);
        console.log(`MOD BANNED IP: ${ip}`);
        socket.emit('notice', { message: `Banned IP ${ip}` });
        return;
      }

      if (trimmedMessage.startsWith('/ban @')) {
        const targetUsername = trimmedMessage.slice(6).trim();
        boardUsers.forEach((set, bid) => {
          set.forEach(u => {
            if (u.username === targetUsername) {
              const targetIP = u.socketId === socket.id ? clientIP : 'unknown';
              bannedIPs.add(targetIP);
              io.sockets.sockets.get(u.socketId)?.disconnect(true);
              console.log(`MOD BANNED USER: ${targetUsername} (IP: ${targetIP})`);
            }
          });
        });
        socket.emit('notice', { message: `Banned user @${targetUsername}` });
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
      message: trimmedMessage,
      timestamp: new Date().toISOString(),
      reactions: {}
    };

    const boardMessages = messages.get(boardId) || [];
    boardMessages.push(messageData);
    if (boardMessages.length > 1000) boardMessages.shift();
    messages.set(boardId, boardMessages);

    io.to(boardId).emit('new_message', messageData);

    console.log(`Message from ${user.username} (ID: ${user.id}) in /${boardId}/: ${trimmedMessage}`);

    // Confetti trigger on "based"
    if (/based/i.test(trimmedMessage)) {
      io.to(boardId).emit('confetti_trigger', { messageId });
      console.log('Confetti triggered for "based" message');
    }
  });

  // Add reaction
  socket.on('add_reaction', ({ messageId, emoji, userId }) => {
    const user = users.get(userId);
    if (!user) return;

    if (!reactions.has(messageId)) reactions.set(messageId, new Map());

    const msgReactions = reactions.get(messageId);
    if (!msgReactions.has(emoji)) msgReactions.set(emoji, new Set());

    const previousCount = msgReactions.get(emoji).size;
    msgReactions.get(emoji).add(userId);

    const newCount = msgReactions.get(emoji).size;

    // Build reaction data for frontend
    const reactionData = {};
    msgReactions.forEach((userSet, emo) => {
      reactionData[emo] = userSet.size;
    });

    io.to(currentBoard || boardId).emit('message_reactions_update', { messageId, reactions: reactionData });

    console.log(`${user.username} reacted ${emoji} to message ${messageId} (count: ${newCount})`);
  });

  socket.on('disconnect', () => {
    messageTimestamps.delete(socket.id);

    boardUsers.forEach((usersSet, boardId) => {
      let removedUser = null;
      for (const userInfo of usersSet) {
        if (userInfo.socketId === socket.id) {
          removedUser = userInfo;
          usersSet.delete(userInfo);
          break;
        }
      }

      if (removedUser) {
        const onlineUsers = Array.from(usersSet).map(u => ({
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

        console.log(`${removedUser.username} disconnected from /${boardId}/ (online: ${onlineUsers.length})`);
      }
    });

    console.log('Client disconnected:', socket.id);
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 4chain backend with moderation, confetti & reactions running on port ${PORT}`);
});