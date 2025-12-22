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

const users = new Map();           // userId → { id, username, avatar }
const messages = new Map();        // boardId → array of messages
const boardUsers = new Map();      // boardId → Set of { socketId, userId, username, avatar }

// Initialize default Anonymous user
let userIdCounter = 1;
users.set(userIdCounter, { id: userIdCounter, username: 'Anonymous', avatar: 'AN' });

// Initialize message storage for each board
boards.forEach(board => {
  messages.set(board.id, []);
});

// API Routes
app.get('/api/boards', (req, res) => {
  res.json(boards);
});

app.get('/api/boards/:boardId/messages', (req, res) => {
  const { boardId } = req.params;
  const boardMessages = messages.get(boardId) || [];
  res.json(boardMessages.slice(-50)); // Last 50 messages
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

// Socket.IO Events
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Join a board with user info
  socket.on('join_board', ({ boardId, user }) => {
    if (!user || !user.id || !users.has(user.id)) {
      console.warn('Invalid user attempting to join board:', user);
      return;
    }

    socket.join(boardId);

    if (!boardUsers.has(boardId)) {
      boardUsers.set(boardId, new Set());
    }

    const userInfo = {
      socketId: socket.id,
      userId: user.id,
      username: user.username,
      avatar: user.avatar
    };

    boardUsers.get(boardId).add(userInfo);

    // Prepare clean list of online users
    const onlineUsers = Array.from(boardUsers.get(boardId)).map(u => ({
      userId: u.userId,
      username: u.username,
      avatar: u.avatar
    }));

    const count = onlineUsers.length;

    // Emit full user list
    io.to(boardId).emit('online_users_update', {
      boardId,
      users: onlineUsers,
      count
    });

    // Backward compatibility: still send count for old clients
    io.to(boardId).emit('user_count_update', {
      boardId,
      count
    });

    console.log(`${user.username} joined /${boardId}/ (online: ${count})`);
  });

  // Leave a board
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

      const count = onlineUsers.length;

      io.to(boardId).emit('online_users_update', {
        boardId,
        users: onlineUsers,
        count
      });

      io.to(boardId).emit('user_count_update', {
        boardId,
        count
      });

      console.log(`${removedUser.username} left /${boardId}/ (online: ${count})`);
    }

    socket.leave(boardId);
  });

  // Send message
  socket.on('send_message', ({ boardId, message, userId: messageUserId }) => {
    try {
      const user = users.get(messageUserId) || users.get(1);
      if (!user) {
        socket.emit('error', { message: 'Invalid user' });
        return;
      }

      const trimmedMessage = message.trim();
      if (trimmedMessage === '') return;

      const messageId = Date.now();
      const messageData = {
        id: messageId,
        board_id: boardId,
        user_id: user.id,
        username: user.username,
        avatar: user.avatar,
        message: trimmedMessage,
        timestamp: new Date().toISOString()
      };

      const boardMessages = messages.get(boardId) || [];
      boardMessages.push(messageData);
      // Optional: limit stored messages to prevent memory growth
      if (boardMessages.length > 1000) boardMessages.shift();
      messages.set(boardId, boardMessages);

      io.to(boardId).emit('new_message', messageData);
      console.log(`Message from ${user.username} in /${boardId}/`);
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

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

        const count = onlineUsers.length;

        io.to(boardId).emit('online_users_update', {
          boardId,
          users: onlineUsers,
          count
        });

        io.to(boardId).emit('user_count_update', {
          boardId,
          count
        });

        console.log(`${removedUser.username} disconnected from /${boardId}/ (online: ${count})`);
      }
    });
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 4chain backend running on port ${PORT}`);
});