const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const rooms = new Map();

const server = http.createServer((req, res) => {
if (req.url === '/' || req.url === '/health') {
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({
game: 'Black Gates',
status: 'online',
rooms: rooms.size
}));
}

res.writeHead(404);
res.end('Not found');
});

const wss = new WebSocketServer({ server });

function send(ws, data) {
if (ws.readyState === WebSocket.OPEN) {
ws.send(JSON.stringify(data));
}
}

function broadcast(room, data, excluded = null) {
for (const player of room.players.values()) {
if (player !== excluded) send(player, data);
}
}

function leaveRoom(ws) {
if (!ws.roomCode) return;

const room = rooms.get(ws.roomCode);
if (room) {
room.players.delete(ws.id);

broadcast(room, {
  type: 'playerLeft',
  playerId: ws.id
});

if (room.players.size === 0) {
  rooms.delete(ws.roomCode);
}

}

ws.roomCode = null;
}

wss.on('connection', (ws) => {
ws.id = crypto.randomUUID();
ws.roomCode = null;

send(ws, {
type: 'connected',
playerId: ws.id
});

ws.on('message', (raw) => {
let message;

try {
  message = JSON.parse(raw.toString());
} catch {
  return send(ws, { type: 'error', message: 'Mensagem inválida.' });
}

if (!message || typeof message.type !== 'string') {
  return send(ws, { type: 'error', message: 'Tipo de mensagem inválido.' });
}

if (message.type === 'createRoom') {
  leaveRoom(ws);

  let code;
  do {
    code = crypto.randomBytes(3)
      .toString('hex')
      .slice(0, 5)
      .toUpperCase();
  } while (rooms.has(code));

  const room = { players: new Map() };
  rooms.set(code, room);
  room.players.set(ws.id, ws);
  ws.roomCode = code;

  return send(ws, {
    type: 'roomCreated',
    roomCode: code,
    playerId: ws.id,
    players: [ws.id]
  });
}

if (message.type === 'joinRoom') {
  const code = String(message.roomCode || '').trim().toUpperCase();
  const room = rooms.get(code);

  if (!room) {
    return send(ws, { type: 'error', message: 'Sala não encontrada.' });
  }

  if (room.players.size >= MAX_PLAYERS) {
    return send(ws, { type: 'error', message: 'Sala cheia.' });
  }

  leaveRoom(ws);

  room.players.set(ws.id, ws);
  ws.roomCode = code;

  send(ws, {
    type: 'roomJoined',
    roomCode: code,
    playerId: ws.id,
    players: [...room.players.keys()]
  });

  broadcast(room, {
    type: 'playerJoined',
    playerId: ws.id
  }, ws);

  return;
}

if (message.type === 'leaveRoom') {
  leaveRoom(ws);
  return send(ws, { type: 'leftRoom' });
}

if (message.type === 'sync') {
  if (!ws.roomCode) {
    return send(ws, { type: 'error', message: 'Entre em uma sala primeiro.' });
  }

  const room = rooms.get(ws.roomCode);
  if (!room) return leaveRoom(ws);

  broadcast(room, {
    type: 'sync',
    playerId: ws.id,
    state: message.state
  }, ws);

  return;
}

if (message.type === 'ping') {
  return send(ws, { type: 'pong' });
}

});

ws.on('close', () => leaveRoom(ws));
ws.on('error', () => leaveRoom(ws));
});

server.listen(PORT, '0.0.0.0', () => {
console.log("Black Gates server listening on port ${PORT}");
});
