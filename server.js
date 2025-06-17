const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const mongoose = require("mongoose");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors((origin = "https://livefunstream.netlify.app/")));
app.use(express.json());

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

// User Schema
const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    isStreaming: { type: Boolean, default: false },
    followers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    following: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

const User = mongoose.model("User", userSchema);

// Stream Schema
const streamSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: String,
    streamer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    viewers: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    isLive: { type: Boolean, default: true },
    startTime: { type: Date, default: Date.now },
    endTime: Date,
  },
  { timestamps: true }
);

const Stream = mongoose.model("Stream", streamSchema);

// Auth Routes
app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      username,
      email,
      password: hashedPassword,
    });

    await user.save();
    const token = jwt.sign({ userId: user._id }, "your-secret-key");

    res.status(201).json({
      token,
      user: { id: user._id, username: user.username, email: user.email },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ userId: user._id }, "your-secret-key");

    res.json({
      token,
      user: { id: user._id, username: user.username, email: user.email },
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Stream Routes
app.get("/api/streams", async (req, res) => {
  try {
    const streams = await Stream.find({ isLive: true })
      .populate("streamer", "username")
      .populate("viewers", "username");
    res.json(streams);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/streams", async (req, res) => {
  try {
    const { title, description, streamerId } = req.body;

    const stream = new Stream({
      title,
      description,
      streamer: streamerId,
    });

    await stream.save();
    await User.findByIdAndUpdate(streamerId, { isStreaming: true });

    res.status(201).json(stream);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Socket.io for real-time communication
const activeStreams = new Map();
const streamViewers = new Map();

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  // Handle stream start
  socket.on("start-stream", (data) => {
    const { streamId, streamerId } = data;
    activeStreams.set(streamId, {
      streamerId,
      socketId: socket.id,
      viewers: new Set(),
    });

    socket.join(`stream-${streamId}`);
    socket.broadcast.emit("new-stream", { streamId, ...data });
  });

  // Handle join stream
  socket.on("join-stream", (data) => {
    const { streamId, viewerId } = data;
    socket.join(`stream-${streamId}`);

    if (activeStreams.has(streamId)) {
      activeStreams.get(streamId).viewers.add(viewerId);

      // Notify streamer about new viewer
      socket.to(`stream-${streamId}`).emit("viewer-joined", {
        viewerId,
        viewerCount: activeStreams.get(streamId).viewers.size,
      });
    }
  });

  // Handle WebRTC signaling
  socket.on("offer", (data) => {
    socket.to(`stream-${data.streamId}`).emit("offer", {
      offer: data.offer,
      from: socket.id,
    });
  });

  socket.on("answer", (data) => {
    socket.to(data.to).emit("answer", {
      answer: data.answer,
      from: socket.id,
    });
  });

  socket.on("ice-candidate", (data) => {
    socket.to(`stream-${data.streamId}`).emit("ice-candidate", {
      candidate: data.candidate,
      from: socket.id,
    });
  });

  // Handle stream end
  socket.on("end-stream", (data) => {
    const { streamId } = data;
    socket.to(`stream-${streamId}`).emit("stream-ended");
    activeStreams.delete(streamId);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    // Clean up if streamer disconnects
    for (let [streamId, streamData] of activeStreams) {
      if (streamData.socketId === socket.id) {
        socket.to(`stream-${streamId}`).emit("stream-ended");
        activeStreams.delete(streamId);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
