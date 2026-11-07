
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


function botCountForRoom(room) {
  return Math.max(0, Math.min(9, 10 - room.players.size));
}

function startRoomBots(room) {
  const wanted = botCountForRoom(room);
  room.bots ||= new Map();
  while (room.bots.size > wanted) {
    const id = [...room.bots.keys()].pop();
    room.bots.delete(id); room.states.delete(id); room.hp.delete(id);
    room.inventory.delete(id); room.lastShotAt.delete(id);
    broadcast(room, { type: 'playerLeft', playerId: id });
  }
  while (room.bots.size < wanted) {
    const n = room.bots.size + 1;
    const id = `bot-${n}`;
    const angle = (n / Math.max(1, wanted)) * Math.PI * 2;
    // A SALA TEST usa centro 2000,2000 no cliente.
    const state = {
      x: 2000 + Math.cos(angle) * (100 + n * 7), y: 85,
      z: 2000 + Math.sin(angle) * (100 + n * 7),
      rotationY: angle + Math.PI, yaw: angle + Math.PI, aimPitch: 0,
      moving: true, running: true, jumping: false, crouching: false,
      pistolEquipped: false, umpEquipped: false, dozeEquipped: false,
      m107Equipped: false, flashlightEquipped: false, parachuting: true
    };
    room.bots.set(id, { id, targetId: null, thinkAt: 0, nextMoveAt: 0, landedAt: 0, dead: false, weapon: 'pistol' });
    room.states.set(id, state); room.hp.set(id, 100);
    room.inventory.set(id, { pistol: false, flashlight: false, ump: false, doze: false, m107: false });
    room.lastShotAt.set(id, 0);
    broadcast(room, { type: 'sync', playerId: id, state });
  }
  if (!room.botTimer) room.botTimer = setInterval(() => tickRoomBots(room), 250);
}

function tickRoomBots(room) {
  if (!rooms.has(room.code) || room.players.size === 0) return;
  const now = Date.now();
  const living = [...room.players.keys(), ...[...(room.bots || new Map()).keys()].filter(id => !room.bots.get(id).dead)];
  for (const [id, bot] of room.bots || []) {
    const state = room.states.get(id);
    if (!state || bot.dead) continue;
    if (state.parachuting) {
      state.y = Math.max(0, state.y - 1.8);
      if (state.y <= 0) { state.y = 0; state.parachuting = false; bot.landedAt = now; }
    }
    let targetId = null, best = Infinity;
    for (const candidate of living) {
      if (candidate === id || (room.bots.has(candidate) && room.bots.get(candidate).dead)) continue;
      const other = room.states.get(candidate);
      if (!other) continue;
      const d = Math.hypot(other.x - state.x, other.z - state.z);
      if (d < best) { best = d; targetId = candidate; }
    }
    bot.targetId = targetId;
    const target = targetId && room.states.get(targetId);
    if (target && !state.parachuting) {
      const dx = target.x - state.x, dz = target.z - state.z;
      const distance = Math.hypot(dx, dz);
      state.yaw = Math.atan2(-dx, -dz); state.rotationY = state.yaw;
      if (distance > 8 && now >= bot.nextMoveAt) {
        const step = Math.min(1.15, distance - 5);
        state.x += dx / (distance || 1) * step;
        state.z += dz / (distance || 1) * step;
        state.moving = true; state.running = distance > 14;
        bot.nextMoveAt = now + 250;
      } else { state.moving = false; state.running = false; }
      if (distance <= 20 && now - (room.lastShotAt.get(id) || 0) >= 650) {
        room.lastShotAt.set(id, now);
        broadcast(room, { type: 'shoot', playerId: id });
        const oldHP = room.hp.get(targetId) ?? 100;
        const damage = distance <= 5 ? 17 : distance <= 10 ? 14 : 9;
        const newHP = Math.max(0, oldHP - damage);
        room.hp.set(targetId, newHP);
        broadcast(room, { type: 'playerHP', playerId: targetId, hp: newHP, maxHP: 100, damage: oldHP-newHP, attackerId: id });
        if (newHP === 0) {
          if (room.bots.has(targetId)) room.bots.get(targetId).dead = true;
          broadcast(room, { type: 'playerDeath', playerId: targetId });
        }
      }
    } else if (!state.parachuting && now >= bot.nextMoveAt) {
      const a = Math.random() * Math.PI * 2;
      state.x = Math.max(1562, Math.min(2438, state.x + Math.cos(a) * 8));
      state.z = Math.max(1562, Math.min(2438, state.z + Math.sin(a) * 8));
      state.yaw = Math.atan2(-Math.cos(a), -Math.sin(a)); state.rotationY = state.yaw;
      state.moving = true; state.running = true; bot.nextMoveAt = now + 1800;
    }
    broadcast(room, { type: 'sync', playerId: id, state });
  }
}

function resetX1Items(room) {
  for (const type of ['pistol', 'flashlight', 'ammo', 'ump', 'doze', 'm107']) {
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

  for (const ammoType of ['ump', 'doze', 'm107']) {
    const field = ammoType + 'AmmoItems';
    room[field] = room[field].map(() => true);
    room[ammoType + 'AmmoAvailable'] = true;
    broadcast(room, {
      type: 'itemAvailability',
      itemType: 'ammo',
      ammoType,
      items: [...room[field]],
      available: true,
      playerId: null
    });
  }

  for (const id of room.players.keys()) {
    room.inventory.set(id, { pistol: false, flashlight: false, ump: false, doze: false, m107: false });
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
    if (room.botTimer) clearInterval(room.botTimer);
    rooms.delete(code);
  } else {
    startRoomBots(room);
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
        code,
        players: new Map(),
        bots: new Map(),
        botTimer: null,
        states: new Map(),
        roomLightsOn: true,
        pistolAvailable: true,
        flashlightAvailable: true,
        ammoAvailable: true,
        pistolItems: Array(32).fill(true),
        flashlightItems: [true, true],
        ammoItems: Array(32).fill(true),
        umpAmmoAvailable: true,
        umpAmmoItems: Array(32).fill(true),
        dozeAmmoAvailable: true,
        dozeAmmoItems: Array(32).fill(true),
        m107AmmoAvailable: true,
        m107AmmoItems: Array(32).fill(true),
        umpAvailable: true,
        umpItems: Array(32).fill(true),
        dozeAvailable: true,
        dozeItems: Array(32).fill(true),
        m107Available: true,
        m107Items: Array(32).fill(true),
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
      room.inventory.set(ws.id, { pistol: false, flashlight: false, ump: false, doze: false, m107: false });
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
        ammoItems: room.ammoItems,
        umpAmmoItems: room.umpAmmoItems,
        dozeAmmoItems: room.dozeAmmoItems,
        m107AmmoItems: room.m107AmmoItems,
        umpAvailable: room.umpAvailable,
        umpItems: room.umpItems,
        dozeAvailable: room.dozeAvailable,
        dozeItems: room.dozeItems,
        m107Available: room.m107Available,
        m107Items: room.m107Items
      });
      startRoomBots(room);

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
        ammoItems: room.ammoItems,
        umpAmmoItems: room.umpAmmoItems,
        dozeAmmoItems: room.dozeAmmoItems,
        m107AmmoItems: room.m107AmmoItems,
        umpAvailable: room.umpAvailable,
        umpItems: room.umpItems,
        dozeAvailable: room.dozeAvailable,
        dozeItems: room.dozeItems,
        m107Available: room.m107Available,
        m107Items: room.m107Items
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
      room.inventory.set(ws.id, { pistol: false, flashlight: false, ump: false, doze: false, m107: false });
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
          ammoItems: room.ammoItems,
        umpAmmoItems: room.umpAmmoItems,
        dozeAmmoItems: room.dozeAmmoItems,
        m107AmmoItems: room.m107AmmoItems,
        umpAvailable: room.umpAvailable,
        umpItems: room.umpItems,
        dozeAvailable: room.dozeAvailable,
        dozeItems: room.dozeItems,
        m107Available: room.m107Available,
        m107Items: room.m107Items
      });
      startRoomBots(room);

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


    if (message.type === 'swapWeapon') {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.players.has(ws.id)) return;

      const allowed = ['pistol', 'ump', 'doze', 'm107'];
      const incomingType = message.incomingType;
      const droppedType = message.droppedType;
      const itemId = Number(message.itemId);
      const inventory = room.inventory.get(ws.id);

      if (
        !inventory ||
        !allowed.includes(incomingType) ||
        !allowed.includes(droppedType) ||
        incomingType === droppedType ||
        !inventory[droppedType]
      ) {
        send(ws, { type: 'weaponSwapRejected', reason: 'invalid_inventory' });
        return;
      }

      const incomingItems = room[incomingType + 'Items'];
      const droppedItems = room[droppedType + 'Items'];

      if (
        !Number.isInteger(itemId) ||
        itemId < 0 ||
        itemId >= incomingItems.length ||
        !incomingItems[itemId]
      ) {
        send(ws, { type: 'weaponSwapRejected', reason: 'unavailable' });
        return;
      }

      const droppedItemId = droppedItems.findIndex(value => !value);
      if (droppedItemId < 0) {
        send(ws, { type: 'weaponSwapRejected', reason: 'no_drop_space' });
        return;
      }

      incomingItems[itemId] = false;
      droppedItems[droppedItemId] = true;
      inventory[incomingType] = true;
      inventory[droppedType] = false;

      room[incomingType + 'Available'] = incomingItems.some(Boolean);
      room[droppedType + 'Available'] = droppedItems.some(Boolean);

      broadcast(room, {
        type: 'weaponSwap',
        playerId: ws.id,
        incomingType,
        droppedType,
        incomingItemId: itemId,
        droppedItemId,
        pistolItems: [...room.pistolItems],
        umpItems: [...room.umpItems],
        dozeItems: [...room.dozeItems],
        m107Items: [...room.m107Items]
      });
      return;
    }

    if (
      message.type === 'collectFlashlight' ||
      message.type === 'collectPistol' ||
      message.type === 'collectAmmo' ||
      message.type === 'collectUMP' ||
      message.type === 'collectDoze' ||
      message.type === 'collectM107'
    ) {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.players.has(ws.id)) return;

      const itemType = message.type === 'collectFlashlight'
        ? 'flashlight'
        : message.type === 'collectPistol' ? 'pistol'
        : message.type === 'collectUMP' ? 'ump'
        : message.type === 'collectDoze' ? 'doze'
        : message.type === 'collectM107' ? 'm107' : 'ammo';

      const ammoType = itemType === 'ammo'
        ? (['ump', 'doze', 'm107'].includes(message.ammoType) ? message.ammoType : 'pistol')
        : null;
      const field = itemType === 'ammo'
        ? (ammoType === 'pistol' ? 'ammoItems' : ammoType + 'AmmoItems')
        : itemType + 'Items';
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
      const availabilityKey = itemType === 'ammo'
        ? (ammoType === 'pistol' ? 'ammoAvailable' : ammoType + 'AmmoAvailable')
        : itemType + 'Available';
      room[availabilityKey] = items.some(Boolean);

      broadcast(room, {
        type: 'itemAvailability',
        itemType,
        ...(ammoType ? { ammoType } : {}),
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
      const weapon = ['pistol', 'ump', 'doze', 'm107'].includes(message.weapon)
        ? message.weapon
        : 'pistol';
      const shotIntervals = { pistol: 1000, ump: 80, doze: 1000, m107: 1500 };
      const previousShot = room.lastShotAt.get(ws.id) || 0;
      if (now - previousShot < shotIntervals[weapon]) return;
      room.lastShotAt.set(ws.id, now);

      // Prioriza a mira real enviada pelo cliente; mantém fallback compatível.
  const origin = message.origin;
  const direction = message.direction;
  const validAim = origin && direction &&
    [origin.x, origin.y, origin.z, direction.x, direction.y, direction.z]
      .every(value => typeof value === 'number' && Number.isFinite(value));
  const originOffset = validAim
    ? Math.hypot(origin.x - shooterState.x, origin.z - shooterState.z)
    : Infinity;
  const directionLength = validAim
    ? Math.hypot(direction.x, direction.y, direction.z)
    : 0;
  const useCameraAim = validAim && originOffset <= 8 &&
    directionLength >= 0.9 && directionLength <= 1.1;

  const yaw = shooterState.yaw || 0;
  const pitch = shooterState.aimPitch || 0;
  const dx = useCameraAim ? direction.x / directionLength : -Math.sin(yaw) * Math.cos(pitch);
  const dy = useCameraAim ? direction.y / directionLength : -Math.sin(pitch);
  const dz = useCameraAim ? direction.z / directionLength : -Math.cos(yaw) * Math.cos(pitch);

  const shotDirections = [{ x: dx, y: dy, z: dz }];
  if (weapon === 'doze') {
    const right = { x: -dz, y: 0, z: dx };
    const up = { x: -dx * dy, y: dx * dx + dz * dz, z: -dz * dy };
    for (const [horizontal, vertical] of [[-0.045, 0], [0.045, 0], [0, -0.045], [0, 0.045]]) {
      const vx = dx + right.x * horizontal + up.x * vertical;
      const vy = dy + right.y * horizontal + up.y * vertical;
      const vz = dz + right.z * horizontal + up.z * vertical;
      const length = Math.hypot(vx, vy, vz) || 1;
      shotDirections.push({ x: vx / length, y: vy / length, z: vz / length });
    }
  }

  const sx = useCameraAim ? origin.x : shooterState.x;
  const sy = useCameraAim ? origin.y : (shooterState.y || 0) + (shooterState.crouching ? 0.95 : 1.35);
  const sz = useCameraAim ? origin.z : shooterState.z;

  const maxRange = weapon === 'm107' ? 375 : 20;
  const hitZones = weapon === 'doze' ? [
    { part: 'head', y: 1.68, radius: 0.38, damage: 100 },
    { part: 'chest', y: 1.22, radius: 0.60, damage: 34 },
    { part: 'arms', y: 0.98, radius: 0.72, damage: 25 },
    { part: 'legs', y: 0.48, radius: 0.58, damage: 12 }
  ] : weapon === 'm107' ? [
    { part: 'head', y: 1.68, radius: 0.38, damage: 100 },
    { part: 'chest', y: 1.22, radius: 0.60, damage: 95 },
    { part: 'arms', y: 0.98, radius: 0.72, damage: 85 },
    { part: 'legs', y: 0.48, radius: 0.58, damage: 75 }
  ] : [
    { part: 'head', y: 1.68, radius: 0.38, damage: 45 },
    { part: 'chest', y: 1.22, radius: 0.60, damage: 25 },
    { part: 'arms', y: 0.98, radius: 0.72, damage: 10 },
    { part: 'legs', y: 0.48, radius: 0.58, damage: 12 }
  ];

  let targetId = null;
  let targetDistance = maxRange + 1;
  let targetPart = null;
  let baseDamage = 0;
  const pelletDamageByTarget = new Map();

  for (const shotDirection of shotDirections) {
    let pelletTargetId = null;
    let pelletDistance = maxRange + 1;
    let pelletPart = null;
    let pelletDamage = 0;

    for (const [otherId, targetState] of room.states) {
      if (otherId === ws.id || (!room.players.has(otherId) && !room.bots?.has(otherId))) continue;

      const tx = targetState.x - sx;
      const tz = targetState.z - sz;
      const targetY = targetState.y || 0;
      const crouchOffset = targetState.crouching ? 0.65 : 0;

      for (const zone of hitZones) {
        const zoneY = targetY + zone.y - crouchOffset;
        const ty = zoneY - sy;
        const along = tx * shotDirection.x +
          ty * shotDirection.y + tz * shotDirection.z;

        if (along < 0 || along > maxRange || along >= pelletDistance) continue;

        const px = tx - along * shotDirection.x;
        const py = ty - along * shotDirection.y;
        const pz = tz - along * shotDirection.z;

        const radialDistance = px * px + py * py + pz * pz;
        if (radialDistance > zone.radius * zone.radius) continue;

        if (along < pelletDistance) {
          pelletTargetId = otherId;
          pelletDistance = along;
          pelletPart = zone.part;
          pelletDamage = zone.damage;
        }
      }
    }

    if (pelletTargetId) {
      const previous = pelletDamageByTarget.get(pelletTargetId) || {
        damage: 0,
        distance: pelletDistance,
        part: pelletPart
      };

      if (weapon === 'doze') {
        previous.zoneHits ||= { head: 0, chest: 0, arms: 0, legs: 0 };
        previous.zoneHits[pelletPart]++;
        previous.distance = Math.min(previous.distance, pelletDistance);
      } else {
        previous.damage += pelletDamage;
        previous.distance = Math.min(previous.distance, pelletDistance);
        previous.part = pelletPart;
      }
      pelletDamageByTarget.set(pelletTargetId, previous);
    }
  }

  if (weapon === 'doze') {
    for (const hit of pelletDamageByTarget.values()) {
      const counts = hit.zoneHits || {};
      let part = 'chest';
      for (const candidate of ['arms', 'legs', 'head']) {
        if ((counts[candidate] || 0) > (counts[part] || 0)) {
          part = candidate;
        }
      }
      hit.part = part;
      hit.damage = { head: 100, chest: 34, arms: 25, legs: 12 }[part];
    }
  }

  for (const [id, hit] of pelletDamageByTarget) {
    if (hit.damage > baseDamage) {
      targetId = id;
      baseDamage = Math.min(100, hit.damage);
      targetDistance = hit.distance;
      targetPart = hit.part;
    }
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
        const damageDistance = Math.hypot(
          targetState.x - shooterState.x,
          targetState.z - shooterState.z
        );
        const distanceMultiplier = weapon === 'doze' ? 1 :
          damageDistance <= 5 ? 1 :
          damageDistance <= 10 ? 0.8 :
          damageDistance <= 15 ? 0.6 : 0.35;
    const damage = Math.max(1, Math.round(baseDamage * distanceMultiplier));
    const botCombat = room.bots?.has(ws.id) || room.bots?.has(targetId);
        const damageAllowed = botCombat || (room.x1Started && room.x1Phase === 'active' && inX1);
        const newHP = damageAllowed ? Math.max(0, oldHP - damage) : oldHP;
        room.hp.set(targetId, newHP);

        broadcast(room, {
          type: 'playerHP',
          playerId: targetId,
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

        if (newHP === 0 && room.bots?.has(targetId)) {
          room.bots.get(targetId).dead = true;
          broadcast(room, { type: 'playerDeath', playerId: targetId });
        }

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

            setTimeout(() => {
              if (room.players.size !== 2 || room.x1Phase !== 'finished') return;

              room.x1Started = false;
              room.x1Phase = 'waiting';
              room.x1Ready.clear();

              broadcast(room, {
                type: 'x1ReadyUpdate',
                readyPlayers: [],
                playerCount: room.players.size,
                started: false,
                message: 'X1 reiniciado. Os dois jogadores podem ficar prontos para outra partida.'
              });
            }, 2500);
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
    
