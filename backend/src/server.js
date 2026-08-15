import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { config } from './config.js';
import { createAuth } from './auth.js';
import {
  clearAllParticipants,
  closeDatabase,
  getParticipants,
  removeParticipant
} from './database.js';
import { createRaffleService } from './raffle-service.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: config.clientOrigin,
    methods: ['GET', 'POST', 'DELETE']
  }
});
const raffleService = createRaffleService(io);
const auth = createAuth(config);
const backendSourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(backendSourceDirectory, '../..');
const frontendDistDirectory = path.join(projectDirectory, 'frontend', 'dist');
const frontendIndexFile = path.join(frontendDistDirectory, 'index.html');

app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

app.get('/api/raffle/status', (_req, res) => {
  res.json(raffleService.getStatus());
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'kick-nebedolagy' });
});

app.post('/api/auth/login', (req, res) => auth.loginUser(req, res));
app.post('/api/auth/logout', (req, res) => auth.logoutUser(req, res));
app.get('/api/auth/session', (req, res) => {
  if (!auth.isConfigured()) return res.status(503).json({ error: 'Авторизация не настроена на сервере' });
  return res.json({ authenticated: Boolean(auth.getSession(req)) });
});

app.use('/api/raffle', auth.requireAuth);

app.post('/api/raffle/start', async (req, res) => {
  try {
    const result = await raffleService.start(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.post('/api/raffle/stop', (_req, res) => {
  res.json(raffleService.stop());
});

app.get('/api/raffle/participants', (_req, res) => {
  res.json({ participants: getParticipants() });
});

app.delete('/api/raffle/participants/:username', (req, res) => {
  const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';
  if (!username) return res.status(400).json({ error: 'Не указан участник' });

  const removed = removeParticipant(username);
  if (!removed) return res.status(404).json({ error: 'Участник уже отсутствует в списке' });

  const participants = getParticipants();
  io.emit('participants_update', { participants });
  return res.json({ success: true, message: `${username} удалён из списка`, participants });
});

app.post('/api/raffle/draw', (_req, res) => {
  try {
    return res.json(raffleService.draw());
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/api/raffle/reroll', (_req, res) => {
  try {
    return res.json(raffleService.draw({ reroll: true }));
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete('/api/raffle/clear', (_req, res) => {
  const removed = clearAllParticipants();
  raffleService.clearWinner();
  io.emit('participants_update', { participants: [] });
  res.json({ success: true, message: 'Список участников очищен', removed });
});

// In production Render builds the React app before starting this server.
// Serving it from the same origin keeps relative /api and Socket.IO URLs
// working without a second Render service or a frontend API setting.
if (existsSync(frontendDistDirectory)) {
  app.use(express.static(frontendDistDirectory));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    return res.sendFile(frontendIndexFile);
  });
}

io.use((socket, next) => {
  if (auth.socketIsAuthorized(socket)) return next();
  return next(new Error('Требуется вход в аккаунт'));
});

io.on('connection', (socket) => {
  socket.emit('participants_update', { participants: getParticipants() });
  socket.emit('status_update', raffleService.getStatus());
  socket.emit('winner_state', raffleService.getWinnerState());
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled API error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(config.port, () => {
  console.info(`Giveaway backend listening on http://localhost:${config.port}`);
});

function shutdown() {
  raffleService.stop();
  closeDatabase();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
