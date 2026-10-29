
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


function resetX1Items(room) {
  for (const type of ['pistol', 'flashlight', 'ammo']) {
    const field = type + 'Items';
    room[field] = room[field].map(() => true);
    room[type + 'Available'] = true;
    broadcast(room, {
      type: 'itemAvailability',
      itemType: type,
      items: [...room[field]],
      available: true,
      playerId: null
    });
  }

  for (const id of room.players.keys()) {
    room.inventory.set(id, { pistol: false, flashlight: false });
    room.hp.set(id, 100);
    room.lastShotAt.set(id, 0);
    send(room.players.get(id), {
      type: 'playerHP', hp: 100, maxHP: 100, damage: 0
    });
  }
}

function startX1Round(room) {
  if (!room.x1Started || room.players.size !== 2) return;
  if (room.x1RoundTimer) clearInterval(room.x1RoundTimer);

  room.x1RoundNumber = (room.x1RoundNumber || 0) + 1;
  room.x1Phase = 'countdown';
  resetX1Items(room);

  const ids = [...room.players.keys()];
  const spawns = {
    [ids[0]]: { x: 976, y: 0, z: 1000 },
    [ids[1]]: { x: 1024, y: 0, z: 1000 }
  };

  broadcast(room, {
    type: 'x1RoundState',
    phase: 'countdown',
    countdown: 5,
    round: room.x1RoundNumber,
    scores: Object.fromEntries(room.x1Scores || []),
    spawns
  });

  let remaining = 5;
  room.x1RoundTimer = setInterval(() => {
    if (!room.x1Started || room.players.size !== 2) {
      clearInterval(room.x1RoundTimer);
      room.x1RoundTimer = null;
      return;
    }

    remaining--;
    if (remaining <= 0) {
      clearInterval(room.x1RoundTimer);
      room.x1RoundTimer = null;
      room.x1Phase = 'active';
      broadcast(room, {
        type: 'x1RoundState',
        phase: 'active',
        countdown: 0,
        round: room.x1RoundNumber,
        scores: Object.fromEntries(room.x1Scores || [])
      });
    } else {
      broadcast(room, {
        type: 'x1RoundState',
        phase: 'countdown',
        countdown: remaining,
        round: room.x1RoundNumber,
        scores: Object.fromEntries(room.x1Scores || [])
      });
    }
  }, 1000);
}

function leaveRoom(ws) {
  const code = ws.roomCode;
  if (!code) return;

  const room = rooms.get(code);

  ws.roomCode = null;

  if (!room) return;

  if (room.x1RoundTimer) {
    clearInterval(room.x1RoundTimer);
    clearTimeout(room.x1RoundTimer);
    room.x1RoundTimer = null;
  }
  room.x1Phase = 'waiting';
  room.players.delete(ws.id);
  room.states.delete(ws.id);
  if (room.inventory) room.inventory.delete(ws.id);
  if (room.hp) room.hp.delete(ws.id);
  if (room.lastShotAt) room.lastShotAt.delete(ws.id);
  if (room.x1Ready) room.x1Ready.clear();
  room.x1Started = false;

  broadcast(room, {
    type: 'playerLeft',
    playerId: ws.id
  });

  broadcast(room, {
    type: 'x1ReadyUpdate',
    readyPlayers: [],
    playerCount: room.players.size,
    started: false,
    message: 'Um jogador saiu. A prontidão do X1 foi reiniciada.'
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
    'aimPitch', 'supportFold', 'supportHeight', 'supportTilt'
  ];

  for (const key of numericFields) {
    if (state[key] !== undefined &&
        (typeof state[key] !== 'number' ||
         !Number.isFinite(state[key]))) {
      return false;
    }
  }

  const booleanFields = [
    'moving', 'running', 'crouching', 'pistolEquipped', 'flashlightEquipped'
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
    Math.abs(state.x) <= 1100 &&
    Math.abs(state.z) <= 1100 &&
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

    if (message.type === 'playerDeath') {
      const room = rooms.get(ws.roomCode);

      if (room && room.players.get(ws.id) === ws) {
        broadcast(room, {
          type: 'playerDeath',
          playerId: ws.id
        }, ws.id);
      }

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
        pistolAvailable: true,
        flashlightAvailable: true,
        ammoAvailable: true,
        pistolItems: [true, true],
        flashlightItems: [true, true],
        ammoItems: [true, true],
        inventory: new Map(),
        hp: new Map(),
        lastShotAt: new Map(),
        x1Ready: new Set(),
        x1Started: false,
        x1Phase: 'waiting',
        x1RoundNumber: 0,
        x1Scores: new Map(),
        x1RoundTimer: null
      };

      rooms.set(code, room);
      room.players.set(ws.id, ws);
      room.inventory.set(ws.id, { pistol: false, flashlight: false });
      room.hp.set(ws.id, 100);
      room.lastShotAt.set(ws.id, 0);
      ws.roomCode = code;

      send(ws, {
        type: 'roomCreated',
        roomCode: code,
        playerId: ws.id,
        players: [ws.id],
        roomLightsOn: room.roomLightsOn,
        pistolAvailable: room.pistolAvailable,
          flashlightAvailable: room.flashlightAvailable,
          ammoAvailable: room.ammoAvailable,
        pistolItems: room.pistolItems,
        flashlightItems: room.flashlightItems,
        ammoItems: room.ammoItems
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
          pistolAvailable: room.pistolAvailable,
          flashlightAvailable: room.flashlightAvailable,
          ammoAvailable: room.ammoAvailable,
        pistolItems: room.pistolItems,
        flashlightItems: room.flashlightItems,
        ammoItems: room.ammoItems
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
      room.inventory.set(ws.id, { pistol: false, flashlight: false });
      room.hp.set(ws.id, 100);
      room.lastShotAt.set(ws.id, 0);
      ws.roomCode = code;

      send(ws, {
        type: 'roomJoined',
        roomCode: code,
        playerId: ws.id,
        players: [...room.players.keys()],
          roomLightsOn: room.roomLightsOn,
          pistolAvailable: room.pistolAvailable,
          flashlightAvailable: room.flashlightAvailable,
          ammoAvailable: room.ammoAvailable,
          pistolItems: room.pistolItems,
          flashlightItems: room.flashlightItems,
          ammoItems: room.ammoItems
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


    if (
      message.type === 'collectFlashlight' ||
      message.type === 'collectPistol' ||
      message.type === 'collectAmmo'
    ) {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.players.has(ws.id)) return;

      const itemType = message.type === 'collectFlashlight'
        ? 'flashlight'
        : message.type === 'collectPistol' ? 'pistol' : 'ammo';

      const field = itemType + 'Items';
      const itemId = Number(message.itemId ?? 0);
      const items = room[field];

      if (!Number.isInteger(itemId) || itemId < 0 ||
          itemId >= items.length || !items[itemId]) {
        send(ws, {
          type: 'pickupRejected',
          itemType,
          itemId,
          reason: 'unavailable'
        });
        return;
      }

      if (itemType !== 'ammo') {
        const inventory = room.inventory.get(ws.id);
        if (!inventory || inventory[itemType]) {
          send(ws, {
            type: 'pickupRejected',
            itemType,
            itemId,
            reason: 'already_owned'
          });
          return;
        }
        inventory[itemType] = true;
      }

      items[itemId] = false;
      room[itemType + 'Available'] = items.some(Boolean);

      broadcast(room, {
        type: 'itemAvailability',
        itemType,
        itemId,
        available: false,
        playerId: ws.id,
        items: [...items]
      });
      return;
    }

    if (message.type === 'shoot') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.players.has(ws.id)) return;
      if (room.x1Started && room.x1Phase !== 'active') return;

      const shooterState = room.states.get(ws.id);
      // Evita bloquear tiros por inventário ou equipamento atrasado no sync.
      if (!shooterState) return;

      const now = Date.now();
      const previousShot = room.lastShotAt.get(ws.id) || 0;
      if (now - previousShot < 250) return;
      room.lastShotAt.set(ws.id, now);

      // Direção da câmera, usando o mesmo sistema de yaw/pitch do cliente.
      const yaw = shooterState.yaw || 0;
      const pitch = shooterState.aimPitch || 0;
      const dx = -Math.sin(yaw) * Math.cos(pitch);
      const dy = -Math.sin(pitch);
      const dz = -Math.cos(yaw) * Math.cos(pitch);

      const sx = shooterState.x;
      const sy = (shooterState.y || 0) +
        (shooterState.crouching ? 0.95 : 1.35);
      const sz = shooterState.z;

      const maxRange = 35;
      const hitRadius = 1.2;
      let targetId = null;
      let targetDistance = maxRange + 1;

      for (const [otherId, targetState] of room.states) {
        if (otherId === ws.id || !room.players.has(otherId)) continue;

        const tx = targetState.x - sx;
        const ty = (targetState.y || 0) +
          (targetState.crouching ? 0.75 : 1.0) - sy;
        const tz = targetState.z - sz;

        // Projeção sobre o raio: precisa estar à frente e dentro do alcance.
        const along = tx * dx + ty * dy + tz * dz;
        if (along < 0 || along > maxRange || along >= targetDistance) {
          continue;
        }

        const px = tx - along * dx;
        const py = ty - along * dy;
        const pz = tz - along * dz;
        if (px * px + py * py + pz * pz > hitRadius * hitRadius) {
          continue;
        }

        targetId = otherId;
        targetDistance = along;
      }

      // O servidor confirma o tiro; os demais clientes reproduzem o som.
      broadcast(room, {
        type: 'shoot',
        playerId: ws.id
      }, ws.id);

      if (targetId) {
        const oldHP = room.hp.get(targetId) ?? 100;
        const targetState = room.states.get(targetId);
        const inX1 = targetState &&
          Math.abs(targetState.x - 1000) <= 25 &&
          Math.abs(targetState.z - 1000) <= 25;
        const newHP = inX1 ? Math.max(0, oldHP - 17) : 100;
        room.hp.set(targetId, newHP);

        const targetSocket = room.players.get(targetId);
        send(targetSocket, {
          type: 'playerHP',
          hp: newHP,
          maxHP: 100,
          damage: oldHP - newHP,
          attackerId: ws.id
        });

        broadcast(room, {
          type: 'playerHit',
          playerId: targetId,
          attackerId: ws.id,
          hp: newHP
        });

        if (newHP === 0 && inX1 && room.x1Started && room.x1Phase === 'active') {
          room.x1Phase = 'intermission';
          const scores = room.x1Scores || new Map();
          scores.set(ws.id, (scores.get(ws.id) || 0) + 1);
          room.x1Scores = scores;

          if (room.x1RoundTimer) {
            clearInterval(room.x1RoundTimer);
            room.x1RoundTimer = null;
          }

          const matchOver = scores.get(ws.id) >= 3;
          broadcast(room, {
            type: 'x1RoundEnd',
            winnerId: ws.id,
            defeatedId: targetId,
            scores: Object.fromEntries(scores),
            matchOver
          });

          if (matchOver) {
            room.x1Phase = 'finished';
            broadcast(room, {
              type: 'x1MatchEnd',
              winnerId: ws.id,
              scores: Object.fromEntries(scores)
            });
          } else {
            room.x1RoundTimer = setTimeout(() => {
              room.x1RoundTimer = null;
              if (room.x1Started && room.players.size === 2 && room.x1Phase === 'intermission') {
                startX1Round(room);
              }
            }, 2500);
          }
        }
      }
      return;
    }

    if (message.type === 'x1Ready') {
      const room = rooms.get(ws.roomCode);

      if (!room || !room.players.has(ws.id)) {
        send(ws, { type: 'error', message: 'Entre em uma sala primeiro.' });
        return;
      }

      if (room.players.size !== 2) {
        send(ws, {
          type: 'x1ReadyUpdate',
          readyPlayers: [...room.x1Ready],
          playerCount: room.players.size,
          started: false,
          message: 'O X1 precisa de exatamente 2 jogadores.'
        });
        return;
      }

      const state = room.states.get(ws.id);
      const inEntryLane = state &&
        state.x >= -8.25 && state.x <= -4.35 &&
        state.z >= -30 && state.z < -9;

      if (!inEntryLane) {
        send(ws, {
          type: 'error',
          message: 'Vá até a entrada do portão X1 para ficar pronto.'
        });
        return;
      }

      if (room.x1Started) {
        send(ws, {
          type: 'x1ReadyUpdate',
          readyPlayers: [...room.x1Ready],
          playerCount: room.players.size,
          started: true
        });
        return;
      }

      if (room.x1Ready.has(ws.id)) {
        room.x1Ready.delete(ws.id);
      } else {
        room.x1Ready.add(ws.id);
      }

      const readyPlayers = [...room.x1Ready];
      broadcast(room, {
        type: 'x1ReadyUpdate',
        readyPlayers,
        playerCount: room.players.size,
        started: false
      });

      if (room.x1Ready.size === 2) {
        const ids = [...room.players.keys()];
        room.x1Started = true;

        const spawns = {
          [ids[0]]: { x: 976, y: 0, z: 1000 },
          [ids[1]]: { x: 1024, y: 0, z: 1000 }
        };

        room.x1RoundNumber = 0;
        room.x1Scores = new Map(ids.map(id => [id, 0]));
        room.x1Phase = 'countdown';

        broadcast(room, {
          type: 'x1Start',
          spawns
        });

        startX1Round(room);
      }

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
    
