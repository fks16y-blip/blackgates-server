
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const rooms = new Map();

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      game: 'Black Gates',
      status: 'online',
      rooms: rooms.size
    }));
    return;
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

function broadcast(room, data, excludedId = null) {
  for (const [id, ws] of room.players) {
    if (id !== excludedId) send(ws, data);
  }
}

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;

  const room = rooms.get(code);

  ws.roomCode = null;

  if (!room) return;

  room.players.delete(ws.id);
  room.states.delete(ws.id);

  broadcast(room, {
    type: 'playerLeft',
    playerId: ws.id
  });

  if (room.players.size === 0) {
    rooms.delete(code);
  }
}

function validState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return false;
  }

  const numericFields = [
    'x', 'y', 'z', 'rotationY', 'yaw',
    'supportFold', 'supportHeight', 'supportTilt'
  ];

  for (const key of numericFields) {
    if (state[key] !== undefined &&
        (typeof state[key] !== 'number' ||
         !Number.isFinite(state[key]))) {
      return false;
    }
  }

  const booleanFields = [
    'moving', 'running', 'pistolEquipped', 'flashlightEquipped'
  ];

  for (const key of booleanFields) {
    if (state[key] !== undefined && typeof state[key] !== 'boolean') {
      return false;
    }
  }

  if (typeof state.x !== 'number' || typeof state.z !== 'number') {
    return false;
  }

  return (
    Math.abs(state.x) <= 1000 &&
    Math.abs(state.z) <= 1000 &&
    Math.abs(state.y ?? 0) <= 100 &&
    Math.abs(state.rotationY ?? 0) <= Math.PI * 100 &&
    Math.abs(state.yaw ?? 0) <= Math.PI * 100
  );
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
      send(ws, {
        type: 'error',
        message: 'Mensagem inválida.'
      });
      return;
    }

    if (!message || typeof message.type !== 'string') {
      send(ws, {
        type: 'error',
        message: 'Tipo de mensagem inválido.'
      });
      return;
    }

    if (message.type === 'createRoom') {
      leaveRoom(ws);

      let code;

      do {
        code = String(
          crypto.randomInt(0, 100000)
        ).padStart(5, '0');
      } while (rooms.has(code));

      const room = {
        players: new Map(),
        states: new Map(),
        roomLightsOn: true,
        pistolAvailable: true
      };

      rooms.set(code, room);
      room.players.set(ws.id, ws);
      ws.roomCode = code;

      send(ws, {
        type: 'roomCreated',
        roomCode: code,
        playerId: ws.id,
        players: [ws.id],
        roomLightsOn: room.roomLightsOn,
        pistolAvailable: room.pistolAvailable
      });

      return;
    }

    if (message.type === 'joinRoom') {
      const code = String(message.roomCode ?? '').trim();

      if (!/^\d{5}$/.test(code)) {
        send(ws, {
          type: 'error',
          message: 'O código deve ter exatamente 5 números.'
        });
        return;
      }

      let room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: 'error',
          message: 'Sala não encontrada.'
        });
        return;
      }

      if (ws.roomCode === code) {
        send(ws, {
          type: 'roomJoined',
          roomCode: code,
          playerId: ws.id,
          players: [...room.players.keys()],
          roomLightsOn: room.roomLightsOn,
          pistolAvailable: room.pistolAvailable
        });
        return;
      }

      if (room.players.size >= MAX_PLAYERS) {
        send(ws, {
          type: 'error',
          message: 'Sala cheia. Máximo de 4 jogadores.'
        });
        return;
      }

      leaveRoom(ws);

      room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: 'error',
          message: 'A sala não está mais disponível.'
        });
        return;
      }

      room.players.set(ws.id, ws);
      ws.roomCode = code;

      send(ws, {
        type: 'roomJoined',
        roomCode: code,
        playerId: ws.id,
        players: [...room.players.keys()],
          roomLightsOn: room.roomLightsOn,
          pistolAvailable: room.pistolAvailable
      });

      for (const [playerId, state] of room.states) {
        send(ws, {
          type: 'sync',
          playerId,
          state
        });
      }

      broadcast(room, {
        type: 'playerJoined',
        playerId: ws.id
      }, ws.id);

      return;
    }

    if (message.type === 'leaveRoom') {
      leaveRoom(ws);

      send(ws, {
        type: 'leftRoom'
      });

      return;
    }

    if (message.type === 'roomLights') {
      if (!ws.roomCode) {
        send(ws, {
          type: 'error',
          message: 'Entre em uma sala primeiro.'
        });
        return;
      }

      const room = rooms.get(ws.roomCode);
      if (!room || !room.players.has(ws.id)) {
        leaveRoom(ws);
        return;
      }

      if (typeof message.roomLightsOn !== 'boolean') {
        send(ws, {
          type: 'error',
          message: 'Estado das luzes inválido.'
        });
        return;
      }

      room.roomLightsOn = message.roomLightsOn;
      broadcast(room, {
        type: 'roomLights',
        roomLightsOn: room.roomLightsOn
      }, ws.id);
      return;
    }

    if (message.type === 'collectPistol') {
      const room = rooms.get(ws.roomCode);

      if (!room || !room.players.has(ws.id)) {
        send(ws, {
          type: 'pistolAvailability',
          available: false,
          playerId: null
        });
        return;
      }

      if (!room.pistolAvailable) {
        send(ws, {
          type: 'pistolAvailability',
          available: false,
          playerId: null
        });
        return;
      }

      room.pistolAvailable = false;
      broadcast(room, {
        type: 'pistolAvailability',
        available: false,
        playerId: ws.id
      });
      return;
    }

    if (message.type === 'sync') {
      if (!ws.roomCode) {
        send(ws, {
          type: 'error',
          message: 'Entre em uma sala primeiro.'
        });
        return;
      }

      const room = rooms.get(ws.roomCode);

      if (!room || !room.players.has(ws.id)) {
        leaveRoom(ws);
        return;
      }

      if (!validState(message.state)) {
        send(ws, {
          type: 'error',
          message: 'Posição do jogador inválida.'
        });
        return;
      }

      const state = {
        ...message.state,
        y: message.state.y ?? 0,
        rotationY: message.state.rotationY ?? 0,
        yaw: message.state.yaw ?? 0
      };

      room.states.set(ws.id, state);

      broadcast(room, {
        type: 'sync',
        playerId: ws.id,
        state
      }, ws.id);

      return;
    }

    if (message.type === 'ping') {
      send(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Black Gates server listening on port ${PORT}`);
});
    
