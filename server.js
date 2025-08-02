const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const cors = require("cors");
const { Pool } = require('pg');
require("dotenv").config();

// PostgreSQL database setup
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// PostgreSQL table creation
const initTables = async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS socket_users (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        socket_id TEXT NOT NULL,
        name TEXT,
        room_id TEXT,
        role TEXT
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS live_classes (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        access_code TEXT UNIQUE NOT NULL,
        status TEXT DEFAULT 'scheduled',
        scheduled_at TEXT, 
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log("🗄️ PostgreSQL database initialized successfully");
  } catch (error) {
    console.error('Error initializing PostgreSQL tables:', error);
    process.exit(1);
  }
};

initTables();

// Database helper functions
const dbHelpers = {
  async getSocketId(userId) {
    const result = await db.query("SELECT socket_id FROM socket_users WHERE user_id = $1", [userId]);
    return result.rows[0]?.socket_id;
  },
  
  async getRoomParticipants(roomId) {
    const roomSet = rooms.get(roomId);
    if (!roomSet) return [];
    
    const participants = [];
    
    for (const socketId of roomSet) {
      const result = await db.query("SELECT user_id, name, role FROM socket_users WHERE socket_id = $1", [socketId]);
      const row = result.rows[0];
      
      if (row) {
        participants.push({
          socketId,
          userId: row.user_id,
          name: row.name,
          role: row.role || "student"
        });
      }
    }
    
    return participants;
  },
  
  async deleteSocketUser(socketId, userId = null) {
    if (userId) {
      await db.query("DELETE FROM socket_users WHERE socket_id = $1 OR user_id = $2", [socketId, userId]);
    } else {
      await db.query("DELETE FROM socket_users WHERE socket_id = $1", [socketId]);
    }
  },
  
  async insertSocketUser(userId, socketId, name, roomId, role) {
    await db.query("INSERT INTO socket_users (user_id, socket_id, name, room_id, role) VALUES ($1, $2, $3, $4, $5)", [userId, socketId, name, roomId, role]);
  },
  
  async getSocketUser(socketId) {
    const result = await db.query("SELECT * FROM socket_users WHERE socket_id = $1", [socketId]);
    return result.rows[0];
  },
  
  async updateSocketUserName(newName, socketId) {
    await db.query("UPDATE socket_users SET name = $1 WHERE socket_id = $2", [newName, socketId]);
  },
  
  async updateClassStatus(status, accessCode) {
    const result = await db.query("UPDATE live_classes SET status = $1 WHERE access_code = $2", [status, accessCode]);
    return result;
  }
};

const app = express();
const server = http.createServer(app);

app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET", "POST"],
  credentials: true
}));

const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory room tracking
const rooms = new Map(); // roomId -> Set of socket IDs
const roomTimers = new Map(); // For auto-close functionality
const roomModerators = new Map(); // Track moderators by room -> socket ID
const userSessions = new Map(); // Track unique user sessions

// API Routes
app.post('/classes/start-class/:accessCode', async (req, res) => {
  try {
    const { accessCode } = req.params;
    
    // Update class status to live
    const result = await dbHelpers.updateClassStatus('live', accessCode);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Class not found' });
    }
    
    console.log(`📺 Class ${accessCode} is now LIVE`);
    res.json({ success: true, message: 'Class started successfully' });
  } catch (error) {
    console.error('Error starting class:', error);
    res.status(500).json({ error: 'Failed to start class' });
  }
});

app.post('/classes/end-class/:accessCode', async (req, res) => {
  try {
    const { accessCode } = req.params;
    
    // Update class status to ended
    await dbHelpers.updateClassStatus('ended', accessCode);
    
    // Close the room
    if (rooms.has(accessCode)) {
      io.to(accessCode).emit("class-ended", { reason: "Class ended by moderator" });
      rooms.delete(accessCode);
    }
    
    // Clear any timers
    if (roomTimers.has(accessCode)) {
      clearTimeout(roomTimers.get(accessCode));
      roomTimers.delete(accessCode);
    }
    
    roomModerators.delete(accessCode);
    
    console.log(`❌ Class ${accessCode} ended`);
    res.json({ success: true, message: 'Class ended successfully' });
  } catch (error) {
    console.error('Error ending class:', error);
    res.status(500).json({ error: 'Failed to end class' });
  }
});

io.on("connection", (socket) => {
  console.log("🔌 New socket connection:", socket.id);

  socket.on("join-room", async ({ userId, roomId, name, role = "student" }) => {
    try {
      console.log(`\n👥 JOIN REQUEST:`);
      console.log(`   User: ${name} (${userId})`);
      console.log(`   Role: ${role}`);
      console.log(`   Room: ${roomId}`);
      console.log(`   Socket: ${socket.id}`);
      
      socket.join(roomId);
      
      // Clean up any existing records for this socket AND user ID
      await dbHelpers.deleteSocketUser(socket.id, userId);
      
      // Store user info with role
      await dbHelpers.insertSocketUser(userId, socket.id, name, roomId, role);

      // Add user to in-memory room tracking
      if (!rooms.has(roomId)) {
        rooms.set(roomId, new Set());
      }
      const roomSet = rooms.get(roomId);
      roomSet.add(socket.id);

      // Better moderator tracking with duplicate prevention
      if (role === "moderator") {
        const existingModerator = roomModerators.get(roomId);
        
        if (existingModerator && existingModerator !== socket.id) {
          console.log(`⚠️ Room ${roomId} already has moderator ${existingModerator}, replacing with ${socket.id}`);
        }
        
        roomModerators.set(roomId, socket.id);
        
        // Cancel any existing room closure timer
        if (roomTimers.has(roomId)) {
          clearTimeout(roomTimers.get(roomId));
          roomTimers.delete(roomId);
          io.to(roomId).emit("moderator-returned", { 
            message: "Moderator returned. Class will continue." 
          });
          console.log(`✅ Moderator returned to room ${roomId}, cancelled closure timer`);
        }
      }

      // Get other users in the room (excluding the new joiner)
      const otherUsers = (await dbHelpers.getRoomParticipants(roomId)).filter(user => user.socketId !== socket.id);
      
      console.log(`📤 Sending user list to ${name}:`);
      otherUsers.forEach(user => {
        console.log(`   - ${user.name} (${user.role}) [${user.socketId}]`);
      });
      
      // Send existing users to the new joiner
      socket.emit("user-list", otherUsers);

      // Notify OTHER users that someone joined
      const joinedUserInfo = { 
        userId, 
        socketId: socket.id, 
        name,
        role 
      };
      
      console.log(`📢 Broadcasting join to ${otherUsers.length} other users in room ${roomId}`);
      socket.to(roomId).emit("user-joined", joinedUserInfo);

      console.log(`✅ ${name} joined room ${roomId}. Total in room: ${roomSet.size}\n`);
    } catch (error) {
      console.error('Error in join-room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });

  // Handle name changes
  socket.on("name-changed", async ({ roomId, newName }) => {
    try {
      console.log(`📝 User ${socket.id} changed name to: ${newName} in room ${roomId}`);
      
      const currentUser = await dbHelpers.getSocketUser(socket.id);
      
      if (currentUser) {
        const oldName = currentUser.name;
        
        // Update name in database
        await dbHelpers.updateSocketUserName(newName, socket.id);
        
        // Broadcast name change to all other users in the room
        socket.to(roomId).emit("user-name-changed", {
          socketId: socket.id,
          newName: newName
        });
        
        console.log(`✅ Name updated: ${oldName} → ${newName} in room ${roomId}`);
      }
    } catch (error) {
      console.error('Error updating name:', error);
      socket.emit('error', { message: 'Failed to update name' });
    }
  });

  // Voice activity detection
  socket.on("voice-activity", ({ roomId, isActive }) => {
    socket.to(roomId).emit("user-voice-activity", {
      socketId: socket.id,
      isActive
    });
  });

  // WebRTC signaling
  socket.on("offer", ({ offer, to, from }) => {
    console.log(`📤 Relaying offer: ${from} → ${to}`);
    io.to(to).emit("offer", { offer, from });
  });

  socket.on("answer", ({ answer, to, from }) => {
    console.log(`📤 Relaying answer: ${from} → ${to}`);
    io.to(to).emit("answer", { answer, from });
  });

  socket.on("ice-candidate", ({ candidate, to, from }) => {
    console.log(`📤 Relaying ICE candidate: ${from} → ${to}`);
    io.to(to).emit("ice-candidate", { candidate, from });
  });

  // Disconnect handling
  socket.on("disconnect", async () => {
    try {
      console.log(`\n❌ Socket disconnected: ${socket.id}`);
      
      // Get user info before deleting
      const user = await dbHelpers.getSocketUser(socket.id);
      
      if (user) {
        console.log(`   User was: ${user.name} (${user.role}) in room ${user.room_id}`);
      }
      
      // Delete from database
      await dbHelpers.deleteSocketUser(socket.id);

      // Handle room cleanup
      for (const [roomId, roomSet] of rooms.entries()) {
        if (roomSet.has(socket.id)) {
          roomSet.delete(socket.id);
          
          // Notify others in the room
          socket.to(roomId).emit("user-disconnected", socket.id);
          console.log(`📢 Notified room ${roomId} of disconnect`);
          
          // Better moderator disconnect handling
          if (user && user.role === "moderator" && roomModerators.get(roomId) === socket.id) {
            console.log(`⚠️ Moderator disconnected from room ${roomId}`);
            
            // Only start timer if there are still other users in the room
            if (roomSet.size > 0) {
              console.log(`⏰ Starting 1-minute closure timer for room ${roomId} (${roomSet.size} users remaining)`);
              
              // Notify remaining users
              io.to(roomId).emit("moderator-left", { 
                message: "Moderator left the class. Room will close in 1 minute unless moderator returns.",
                countdown: 60
              });
              
              // Start 1-minute timer
              const timer = setTimeout(async () => {
                console.log(`⏰ Closing room ${roomId} - moderator didn't return`);
                
                // Update class status to ended
                await dbHelpers.updateClassStatus('ended', roomId);
                
                // Notify remaining users and close room
                io.to(roomId).emit("room-closed", { 
                  reason: "Moderator left and didn't return within 1 minute" 
                });
                
                // Clean up
                rooms.delete(roomId);
                roomTimers.delete(roomId);
                roomModerators.delete(roomId);
                
              }, 60000); // 1 minute
              
              roomTimers.set(roomId, timer);
            } else {
              console.log(`🗑️ Room ${roomId} is empty, cleaning up immediately`);
              rooms.delete(roomId);
              roomModerators.delete(roomId);
            }
            
            // Remove moderator tracking
            roomModerators.delete(roomId);
          }
          
          // Remove empty rooms
          if (roomSet.size === 0) {
            console.log(`🗑️ Room ${roomId} is now empty, removing`);
            rooms.delete(roomId);
            if (roomTimers.has(roomId)) {
              clearTimeout(roomTimers.get(roomId));
              roomTimers.delete(roomId);
            }
            roomModerators.delete(roomId);
          } else {
            console.log(`📊 Room ${roomId} now has ${roomSet.size} users`);
          }
        }
      }
      
      console.log(`✅ Cleanup completed for ${socket.id}\n`);
    } catch (error) {
      console.error('Error in disconnect handler:', error);
    }
  });
});

server.listen(7860, () => {
  console.log("🚀 Server running on port 7860 with WebSocket support");
  console.log("🗄️ Using PostgreSQL database");
});