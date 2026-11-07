
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

// Reproduz no servidor a altura do terreno da SALA TEST (incluindo a montanha oeste).
function botGroundHeight(worldX, worldZ) {
  const x = worldX - 2000, z = worldZ - 2000;
  const dx = x + 55, dz = z + 45;
  const angle = Math.atan2(dz, dx);
  const direction = 1 + 0.48 * Math.cos(angle - 0.7);
  const irregularity = 1 + 0.045 * Math.sin(angle * 3 + 0.8) + 0.025 * Math.sin(angle * 5 - 1.4);
  const radiusSquared = ((dx / 135) ** 2 + (dz / 125) ** 2) / (direction * irregularity) ** 2;
  const shape = Math.max(0, 1 - radiusSquared);
  let height = 56 * Math.pow(shape, 1.35);
  for (const [hx, hz, h, radius] of [[-25,-270,3.2,11],[25,-278,4,12],[-22,-315,3.5,10],[24,-322,3,11]]) {
    const d = Math.hypot(x-hx, z-hz);
    height += h * Math.exp(-(d*d)/(2*radius*radius));
  }
  const mdx = x + 315, mdz = z;
  const radius = Math.sqrt((mdx/90)**2 + (mdz/78)**2);
  const cliffT = Math.max(0, Math.min(1, (radius-0.56)/0.22));
  const cliffSmooth = cliffT*cliffT*(3-2*cliffT);
  const mesaHeight = 36*(1-cliffSmooth);
  const rampT = Math.max(0, Math.min(1, (-x-195)/105));
  const rampCenterZ = 18*Math.sin(rampT*Math.PI*1.15);
  const rampDistance = Math.abs(z-rampCenterZ);
  const rampTaper = Math.max(0, Math.min(1, (rampDistance-11)/15));
  const rampFade = 1-rampTaper*rampTaper*(3-2*rampTaper);
  const rampHeight = 36*rampT;
  height += Math.max(0, mesaHeight*(1-rampFade)+rampHeight*rampFade);
  return height;
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
    // Formação dentro do avião. Cada bot recebe uma zona e um ponto de salto próprios.
    const dropZones = [
      { x: 1685, z: 2000 }, { x: 1710, z: 2020 }, { x: 1665, z: 1980 },
      { x: 1985, z: 1755 }, { x: 2015, z: 1765 }, { x: 1960, z: 1745 },
      { x: 2040, z: 1790 }, { x: 2150, z: 1940 }, { x: 2220, z: 2050 }
    ];
    const dropTarget = dropZones[(n - 1) % dropZones.length];
    const startX = 2000 - 438 + 35;
    const seatRow = Math.floor((n - 1) / 3);
    const seatCol = ((n - 1) % 3) - 1;
    const state = {
      x: startX - seatRow * 2.2, y: 100 + (seatRow % 2) * 0.15,
      z: 2000 + seatCol * 2.4,
      rotationY: -Math.PI / 2, yaw: -Math.PI / 2, aimPitch: 0,
      moving: false, running: false, jumping: false, crouching: false,
      pistolEquipped: false, umpEquipped: false, dozeEquipped: false,
      m107Equipped: false, flashlightEquipped: false, parachuting: false
    };
    room.bots.set(id, {
      id, phase: 'flight', dropTarget,
      jumpX: startX + 160 + (n - 1) * 55,
      targetId: null, targetLockUntil: 0, lootTarget: null, lootThinkAt: 0,
      thinkAt: 0, nextMoveAt: 0, nextSyncAt: 0,
      landedAt: 0, dead: false, weapon: null
    });
    room.states.set(id, state); room.hp.set(id, 100);
    room.inventory.set(id, { pistol: false, flashlight: false, ump: false, doze: false, m107: false });
    room.lastShotAt.set(id, 0);
    broadcast(room, { type: 'sync', playerId: id, state });
  }
  if (!room.botTimer) room.botTimer = setInterval(() => tickRoomBots(room), 250);
}


const BOT_TEST_ROOM_LOOT_SPOTS = [
  [-205,-65],[-198,-32],[-165,105],[-198,32],[-205,65],
  [-220,-80],[-215,80],[-235,-48],[-235,48],[-250,-16],
  [-250,16],[-265,-65],[-265,65],[-385,-65],[-392,-32],
  [-395,0],[-392,32],[-385,65],[-370,-80],[-370,80],
  [-355,-48],[-355,48],[-340,-16],[-340,16],[-355,0],
  [-55,-45],[-90,-100],[65,-110],[175,5],[-125,125]
];
const BOT_VILLAGE_HOUSES = [
  [-15,-245,0],[15,-245,Math.PI/2],[-45,-270,0],[45,-270,Math.PI/2],[-35,-260,0]
];
const BOT_LOOT_CATEGORIES = { pistol: 0, ump: 5, doze: 6, m107: 7 };
function botLootPosition(type, itemId) {
  const index = itemId - 2;
  if (index < 0 || index >= 30) return null;
  const category = BOT_LOOT_CATEGORIES[type];
  const offsets = [[-2.7,-2],[-0.9,-2],[0.9,-2],[2.7,-2],[-2.7,2],[-0.9,2],[0.9,2],[2.7,2]];
  let x, z;
  if (index >= 25) {
    const [hx,hz,rotation] = BOT_VILLAGE_HOUSES[index - 25];
    const [ox,oz] = offsets[category];
    x = hx + ox*Math.cos(rotation) + oz*Math.sin(rotation);
    z = hz - ox*Math.sin(rotation) + oz*Math.cos(rotation);
  } else {
    const [bx,bz] = BOT_TEST_ROOM_LOOT_SPOTS[index];
    const rotation = index >= 13 && index < 25 ? Math.PI : 0;
    const [ox,oz] = index < 25 ? offsets[category] : [[-7,-5],[-2,-5],[3,-5],[8,-5],[-7,5],[-2,5],[3,5],[8,5]][category];
    x = bx + ox*Math.cos(rotation) + oz*Math.sin(rotation);
    z = bz - ox*Math.sin(rotation) + oz*Math.cos(rotation);
  }
  return { x: 2000 + x, z: 2000 + z };
}
function findBotWeaponLoot(room, state, bot) {
  let best = null;
  for (const type of ['pistol','ump','doze','m107']) {
    const inv = room.inventory.get(bot.id) || {};
    if (inv[type]) continue;
    const items = room[type + 'Items'] || [];
    for (let itemId = 2; itemId < items.length; itemId++) {
      if (!items[itemId]) continue;
      const pos = botLootPosition(type, itemId);
      if (!pos) continue;
      const distance = Math.hypot(pos.x-state.x, pos.z-state.z);
      if (!best || distance < best.distance) best = { type, itemId, ...pos, distance };
    }
  }
  return best;
}
function botCollectWeapon(room, bot, state, loot) {
  const items = room[loot.type + 'Items'];
  if (!items || !items[loot.itemId]) return false;
  items[loot.itemId] = false;
  room[loot.type + 'Available'] = items.some(Boolean);
  const inv = room.inventory.get(bot.id) || {};
  inv[loot.type] = true;
  room.inventory.set(bot.id, inv);
  for (const type of ['pistol','ump','doze','m107']) state[type + 'Equipped'] = type === loot.type;
  bot.weapon = loot.type;
  broadcast(room, {
    type: 'itemAvailability', itemType: loot.type, itemId: loot.itemId,
    available: false, playerId: bot.id, items: [...items]
  });
  broadcast(room, { type: 'sync', playerId: bot.id, state });
  return true;
}

function clampBotPosition(x, z) {
  const center = 2000;
  const maxRadius = 430;
  const dx = x - center, dz = z - center;
  const distance = Math.hypot(dx, dz);
  if (distance <= maxRadius) return { x, z };
  const scale = maxRadius / (distance || 1);
  return { x: center + dx * scale, z: center + dz * scale };
}

function tickRoomBots(room) {
  if (!rooms.has(room.code) || room.players.size === 0) return;
  const now = Date.now();
  const botEntries = [...(room.bots || new Map()).entries()];
  const livingHumans = [...room.players.keys()].filter(id =>
    (room.hp.get(id) ?? 100) > 0 && room.states.has(id)
  );

  for (const [id, bot] of botEntries) {
    const state = room.states.get(id);
    if (!state || bot.dead) continue;

    // Avião: os bots permanecem no avião e saltam em pontos escalonados.
    if (bot.phase === 'flight') {
      state.x = Math.min(bot.jumpX, state.x + 13);
      state.y = 100;
      state.moving = false; state.running = false;
      state.jumping = false; state.parachuting = false;
      if (state.x >= bot.jumpX) {
        bot.phase = 'parachuting';
        state.jumping = true;
        state.parachuting = true;
        state.moving = true;
      }
    } else if (bot.phase === 'parachuting') {
      const tx = bot.dropTarget.x, tz = bot.dropTarget.z;
      const dx = tx - state.x, dz = tz - state.z;
      const distance = Math.hypot(dx, dz);
      const step = Math.min(1.8, distance);
      if (distance > 0.01) {
        state.x += dx / distance * step;
        state.z += dz / distance * step;
        state.yaw = Math.atan2(-dx, -dz);
        state.rotationY = state.yaw;
      }
      const pos = clampBotPosition(state.x, state.z);
      state.x = pos.x; state.z = pos.z;
      const groundY = Math.max(0, botGroundHeight(state.x, state.z));
      state.y = Math.max(groundY, state.y - 0.45);
      state.moving = distance > 2; state.running = false;
      state.jumping = false; state.parachuting = true;
      if (state.y <= groundY + 0.02) {
        state.y = groundY;
        state.x = tx; state.z = tz;
        state.parachuting = false; state.moving = false;
        bot.phase = 'landed'; bot.landedAt = now;
        bot.nextThinkAt = now;
      }
    } else {
      // O servidor usa a mesma origem de pés/terreno do personagem remoto.
      const bounded = clampBotPosition(state.x, state.z);
      state.x = bounded.x; state.z = bounded.z;
      state.y = Math.max(0, botGroundHeight(state.x, state.z));

      const inv = room.inventory.get(id) || {};
      const armedWeapon = ['m107', 'doze', 'ump', 'pistol'].find(type => inv[type]);

      if (!armedWeapon) {
        // Sem arma, os bots ainda caçam o jogador e tentam atacar de perto.
        // Isso evita que fiquem parados ou só caminhem atrás de loot.
        let preyId = null;
        let preyDistance = Infinity;
        for (const humanId of livingHumans) {
          const human = room.states.get(humanId);
          if (!human) continue;
          const d = Math.hypot(human.x - state.x, human.z - state.z);
          if (d < preyDistance) { preyDistance = d; preyId = humanId; }
        }
        if (preyId && (preyDistance < 350 || !findBotWeaponLoot(room, state, bot))) {
          const prey = room.states.get(preyId);
          const dx = prey.x - state.x, dz = prey.z - state.z;
          state.yaw = Math.atan2(-dx, -dz);
          state.rotationY = state.yaw;
          // Fecha até a distância de ataque. O limite anterior (1.9 m)
          // deixava o bot alternando movimento e nunca entrando no golpe.
          if (preyDistance > 2.8 && now >= (bot.nextMoveAt || 0)) {
            const step = Math.min(2.8, preyDistance - 2.2);
            const next = clampBotPosition(state.x + dx / Math.max(preyDistance, 0.001) * step, state.z + dz / Math.max(preyDistance, 0.001) * step);
            state.x = next.x; state.z = next.z;
            state.y = Math.max(0, botGroundHeight(state.x, state.z));
            state.moving = true; state.running = true;
            bot.nextMoveAt = now + 260;
          } else {
            state.moving = false; state.running = false;
            if (preyDistance <= 3.2 && now - (room.lastShotAt.get(id) || 0) >= 800) {
              room.lastShotAt.set(id, now);
              const oldHP = room.hp.get(preyId) ?? 100;
              const newHP = Math.max(0, oldHP - 12);
              room.hp.set(preyId, newHP);
              broadcast(room, { type: 'playerHP', playerId: preyId, hp: newHP, maxHP: 100, damage: oldHP - newHP, attackerId: id });
              if (newHP === 0) broadcast(room, { type: 'playerDeath', playerId: preyId });
            }
          }
        } else {
          // Longe do jogador, saqueia armas. Cada bot continua escolhendo um loot próprio.
          if (!bot.lootTarget || now >= (bot.lootThinkAt || 0) || !room[bot.lootTarget.type + 'Items']?.[bot.lootTarget.itemId]) {
            bot.lootTarget = findBotWeaponLoot(room, state, bot);
            bot.lootThinkAt = now + 1200;
          }
          const loot = bot.lootTarget;
          if (loot) {
            const dx = loot.x - state.x, dz = loot.z - state.z;
            const distance = Math.hypot(dx, dz);
            state.yaw = Math.atan2(-dx, -dz); state.rotationY = state.yaw;
            if (distance <= 2.8) {
              if (botCollectWeapon(room, bot, state, loot)) bot.lootTarget = null;
              state.moving = false; state.running = false;
            } else if (now >= (bot.nextMoveAt || 0)) {
              const step = Math.min(2.2, distance);
              const next = clampBotPosition(state.x + dx / distance * step, state.z + dz / distance * step);
              state.x = next.x; state.z = next.z;
              state.y = Math.max(0, botGroundHeight(state.x, state.z));
              state.moving = true; state.running = true; bot.nextMoveAt = now + 320;
            }
          } else {
            state.moving = false; state.running = false;
          }
        }
      } else {
        // Prioridade real: jogadores humanos vivos. Bots só duelam entre si
        // quando não existe humano vivo na sala, evitando a perseguição em bando.
        let targetId = null;
        if (livingHumans.length) {
          if (bot.targetId && livingHumans.includes(bot.targetId) &&
              now < (bot.targetLockUntil || 0)) {
            targetId = bot.targetId;
          } else {
            let bestScore = Infinity;
            for (const humanId of livingHumans) {
              const humanState = room.states.get(humanId);
              if (!humanState) continue;
              const distance = Math.hypot(humanState.x - state.x, humanState.z - state.z);
              // Pequena variação por bot para distribuir a perseguição em salas cheias.
              const score = distance + ((parseInt(id.replace(/\D/g, ''), 10) || 1) % 3) * 5;
              if (score < bestScore) { bestScore = score; targetId = humanId; }
            }
            bot.targetLockUntil = now + 3500;
          }
        } else {
          let best = Infinity;
          for (const [otherId, otherBot] of botEntries) {
            if (otherId === id || otherBot.dead) continue;
            const otherState = room.states.get(otherId);
            if (!otherState) continue;
            const d = Math.hypot(otherState.x - state.x, otherState.z - state.z);
            if (d < best) { best = d; targetId = otherId; }
          }
        }

        const target = targetId && room.states.get(targetId);
        bot.targetId = targetId;
        if (target) {
          const dx = target.x - state.x, dz = target.z - state.z;
          const distance = Math.hypot(dx, dz);
          state.yaw = Math.atan2(-dx, -dz);
          state.rotationY = state.yaw;

          if (distance > 8 && now >= (bot.nextMoveAt || 0)) {
            const step = Math.min(1.8, distance - 6);
            const next = clampBotPosition(
              state.x + dx / (distance || 1) * step,
              state.z + dz / (distance || 1) * step
            );
            state.x = next.x; state.z = next.z;
            state.y = Math.max(0, botGroundHeight(state.x, state.z));
            state.moving = true; state.running = true;
            bot.nextMoveAt = now + 350;
          } else {
            state.moving = false; state.running = false;
          }

          const interval = { m107: 1500, doze: 1000, ump: 220, pistol: 1000 }[armedWeapon];
          const range = armedWeapon === 'm107' ? 180 : armedWeapon === 'doze' ? 35 : 60;
          if (distance <= range && now - (room.lastShotAt.get(id) || 0) >= interval) {
            room.lastShotAt.set(id, now);
            broadcast(room, { type: 'shoot', playerId: id, weapon: armedWeapon });
            const oldHP = room.hp.get(targetId) ?? 100;
            const damage = armedWeapon === 'm107' ? (distance <= 5 ? 95 : 55)
              : armedWeapon === 'doze' ? (distance <= 5 ? 34 : 18)
              : armedWeapon === 'ump' ? (distance <= 5 ? 12 : 7)
              : (distance <= 5 ? 17 : 9);
            const newHP = Math.max(0, oldHP - damage);
            room.hp.set(targetId, newHP);
            broadcast(room, {
              type: 'playerHP', playerId: targetId, hp: newHP,
              maxHP: 100, damage: oldHP - newHP, attackerId: id
            });
            if (newHP === 0) {
              if (room.bots.has(targetId)) room.bots.get(targetId).dead = true;
              broadcast(room, { type: 'playerDeath', playerId: targetId });
            }
          }
        } else {
          state.moving = false; state.running = false;
        }
      }
    }

    // Envia no máximo 2 atualizações por segundo por bot, em vez de 4.
    // A IA continua decidindo localmente a cada 250 ms.
    if (now >= (bot.nextSyncAt || 0)) {
      bot.nextSyncAt = now + 500;
      broadcast(room, { type: 'sync', playerId: id, state });
    }
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
  const useCameraAim = validAim && originOffset <= 30 &&
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

  const maxRange = weapon === 'm107' ? 375 : weapon === 'doze' ? 35 : 60;
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

  // Fallback de acerto nos bots: absorve pequenas diferenças entre câmera,
  // altura do terreno e posição dos ossos do modelo remoto, sem acertar através do mapa.
  if (!targetId) {
    for (const [botId] of (room.bots || new Map())) {
      const botState = room.states.get(botId);
      if (!botState || room.bots.get(botId)?.dead) continue;
      const tx = botState.x - sx, ty = (botState.y || 0) + 1.0 - sy, tz = botState.z - sz;
      const along = tx * dx + ty * dy + tz * dz;
      if (along < 0 || along > maxRange) continue;
      const px = tx - along * dx, py = ty - along * dy, pz = tz - along * dz;
      const miss = Math.hypot(px, py, pz);
      if (miss <= 2.65 && along < targetDistance) {
        targetId = botId;
        targetDistance = along;
        targetPart = 'chest';
        baseDamage = weapon === 'm107' ? 95 : weapon === 'doze' ? 34 : weapon === 'ump' ? 25 : 25;
      }
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
    
