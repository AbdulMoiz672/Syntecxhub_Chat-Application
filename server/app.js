import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAuth, findSession, User, Session } from './auth.js';

const roomSchema = new mongoose.Schema({ name: { type: String, required: true, unique: true }, description: String });
const messageSchema = new mongoose.Schema({ roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true }, username: String, clientId: String, text: String }, { timestamps: true });
messageSchema.index({ roomId: 1, createdAt: -1, _id: -1 });
export const Room = mongoose.model('Room', roomSchema);
export const Message = mongoose.model('Message', messageSchema);
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

export async function createApp() {
  await Promise.all([User.init(), Session.init()]);
  for (const [name, description] of [['general', 'The place for everything. Say hello.'], ['design', 'Ideas, inspiration, and thoughtful feedback.'], ['development', 'Build things together.'], ['random', 'A little room for the unexpected.']]) {
    await Room.updateOne({ name }, { $setOnInsert: { name, description } }, { upsert: true });
  }
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: 16_384,
    allowRequest: (req, callback) => {
      if (!req.headers.origin) return callback(null, true);
      try {
        const origin = new URL(req.headers.origin);
        const host = new URL(`http://${req.headers.host}`);
        const allowed = origin.host === host.host || (process.env.NODE_ENV !== 'production' && origin.hostname === host.hostname && origin.port === '5173');
        callback(null, allowed);
      } catch { callback(null, false); }
    }
  });
  installAuth(app, sessionId => {
    io.to(`session:${sessionId}`).emit('auth:expired');
    io.in(`session:${sessionId}`).disconnectSockets(true);
  });
  app.get('/api/health', (req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ ok: mongoose.connection.readyState === 1 }));
  app.get('/api/rooms', async (req, res) => res.json(await Room.find().sort({ name: 1 }).lean()));
  app.post('/api/rooms', async (req, res) => {
    const name = clean(req.body.name, 40).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return res.status(400).json({ error: 'Use 1–40 lowercase letters, numbers, or hyphens.' });
    try { res.status(201).json(await Room.create({ name, description: clean(req.body.description, 160) })); }
    catch (error) { if (error.code === 11000) return res.status(409).json({ error: 'A room with this name already exists.' }); throw error; }
  });
  app.get('/api/rooms/:roomId/messages', async (req, res) => {
    if (!validId(req.params.roomId) || !await Room.exists({ _id: req.params.roomId })) return res.status(404).json({ error: 'Room not found.' });
    const messages = await Message.find({ roomId: req.params.roomId }).sort({ createdAt: -1, _id: -1 }).limit(100).lean();
    res.json(messages.reverse());
  });
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  const dist = fileURLToPath(new URL('../client/dist', import.meta.url));
  app.use(express.static(dist));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  app.use((err, req, res, next) => { console.error(err.message); res.status(err.status || 500).json({ error: err.status === 400 ? 'Invalid request body.' : 'Unable to complete request.' }); });
  io.use(async (socket, next) => {
    try {
      const session = await findSession(socket.request.headers.cookie);
      if (!session) return next(new Error('Authentication required.'));
      socket.data.user = session.userId;
      socket.data.sessionId = String(session._id);
      socket.data.expiresAt = session.expiresAt;
      next();
    } catch { next(new Error('Authentication required.')); }
  });
  const typing = new Map();
  const members = roomId => io.to(roomId).emit('room:members', { roomId, members: [...(io.sockets.adapter.rooms.get(roomId) || [])].map(id => ({ id, username: io.sockets.sockets.get(id)?.data.username })).filter(x => x.username) });
  function clearTyping(socket, roomId) {
    const entries = typing.get(roomId);
    if (entries?.has(socket.id)) { clearTimeout(entries.get(socket.id).timer); entries.delete(socket.id); }
    if (entries?.size === 0) typing.delete(roomId);
    io.to(roomId).emit('typing:update', { roomId, usernames: [...(entries?.values() || [])].map(x => x.username) });
  }
  io.on('connection', socket => {
    socket.join(`session:${socket.data.sessionId}`);
    const expiry = setTimeout(() => { socket.emit('auth:expired'); socket.disconnect(true); }, Math.max(0, socket.data.expiresAt.getTime() - Date.now()));
    let lastSend = 0;
    let joining = false;
    socket.on('join-room', async (payload = {}, ack = () => {}) => {
      if (typeof ack !== 'function') return;
      if (joining) return ack({ ok: false, error: 'Room switch in progress. Please try again.' });
      joining = true;
      try {
        const { roomId } = payload || {};
        const username = socket.data.user.name, clientId = String(socket.data.user._id);
        if (!validId(roomId) || !username || !clientId || !await Room.exists({ _id: roomId })) return ack({ ok: false, error: 'Choose a valid room and display name.' });
        const old = socket.data.roomId;
        if (old) { await socket.leave(old); clearTyping(socket, old); members(old); }
        Object.assign(socket.data, { roomId, username, clientId });
        await socket.join(roomId); members(roomId); ack({ ok: true });
      } catch { ack({ ok: false, error: 'Could not join room.' }); }
      finally { joining = false; }
    });
    socket.on('message:send', async (payload = {}, ack = () => {}) => {
      if (typeof ack !== 'function') return;
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      const { roomId, username, clientId } = socket.data;
      if (joining || !roomId || payload?.roomId !== roomId || !text || text.length > 2000) return ack({ ok: false, error: 'Join this room and send 1–2000 characters.' });
      if (Date.now() - lastSend < 300) return ack({ ok: false, error: 'Please wait a moment before sending again.' });
      lastSend = Date.now();
      try {
        const message = (await Message.create({ roomId, username, clientId, text })).toObject();
        io.to(roomId).emit('message:new', message); clearTyping(socket, roomId); ack({ ok: true, message });
      } catch { ack({ ok: false, error: 'Message could not be saved. Please try again.' }); }
    });
    socket.on('typing', payload => {
      const { roomId, username } = socket.data;
      if (!roomId || payload?.roomId !== roomId) return;
      if (!payload.isTyping) return clearTyping(socket, roomId);
      if (!typing.has(roomId)) typing.set(roomId, new Map());
      const entries = typing.get(roomId);
      clearTimeout(entries.get(socket.id)?.timer);
      entries.set(socket.id, { username, timer: setTimeout(() => clearTyping(socket, roomId), 3000) });
      io.to(roomId).emit('typing:update', { roomId, usernames: [...entries.values()].map(x => x.username) });
    });
    socket.on('disconnect', () => { clearTimeout(expiry); const roomId = socket.data.roomId; if (roomId) { clearTyping(socket, roomId); members(roomId); } });
  });
  return { app, httpServer, io };
}
