cat > /home/claude/arena-io-v2/server.js << 'SERVEREOF'
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 10000,
  pingInterval: 5000,
});
app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ─────────────────────────────────────────────────────────────────
const WORLD_W = 2400, WORLD_H = 2400;
const TICK_MS = 1000 / 60;
const PLAYER_R = 15;
const BULLET_R = 5;
const BULLET_SPEED = 10;
const BULLET_LIFE = 180;
const PLAYER_SPEED = 4.0;
const RESPAWN_MS = 3000;
const DAMAGE = 25;
const MAX_HP = 100;
const FIRE_COOLDOWN = 10;
const MAX_BULLETS = 300;
const LEADERBOARD_SIZE = 10;
const ROUND_DURATION_MS = 3 * 60 * 1000; // 3 minutes
const INTERMISSION_MS = 15 * 1000;        // 15 seconds voting
const VOTE_MAP_COUNT = 3;                  // maps offered per vote

const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e8c','#00bcd4','#8bc34a',
];

// ── Maps ──────────────────────────────────────────────────────────────────────
const MAPS = {
  arena: {
    name: 'Arena',
    emoji: '⚔️',
    desc: 'Classic symmetric arena',
    color: '#3498db',
    spawns: [
      {x:200,y:200},{x:2200,y:2200},{x:2200,y:200},{x:200,y:2200},
      {x:1200,y:200},{x:1200,y:2200},{x:200,y:1200},{x:2200,y:1200},
    ],
    obstacles: [
      {x:1100,y:1100,w:200,h:40},{x:1100,y:1260,w:200,h:40},
      {x:1060,y:1140,w:40,h:120},{x:1300,y:1140,w:40,h:120},
      {x:350,y:350,w:140,h:35},{x:350,y:350,w:35,h:140},
      {x:1915,y:350,w:140,h:35},{x:2015,y:350,w:35,h:140},
      {x:350,y:2015,w:35,h:140},{x:350,y:2015,w:140,h:35},
      {x:1915,y:2015,w:140,h:35},{x:2015,y:1875,w:35,h:140},
      {x:250,y:1150,w:220,h:35},{x:250,y:1215,w:35,h:80},
      {x:1930,y:1150,w:220,h:35},{x:2115,y:1150,w:35,h:80},
      {x:1150,y:250,w:35,h:220},{x:1215,y:250,w:80,h:35},
      {x:1150,y:1930,w:35,h:220},{x:1150,y:2115,w:80,h:35},
      {x:680,y:680,w:80,h:80},{x:1640,y:680,w:80,h:80},
      {x:680,y:1640,w:80,h:80},{x:1640,y:1640,w:80,h:80},
      {x:1040,y:580,w:80,h:80},{x:1280,y:580,w:80,h:80},
      {x:1040,y:1740,w:80,h:80},{x:1280,y:1740,w:80,h:80},
      {x:580,y:1040,w:80,h:80},{x:580,y:1280,w:80,h:80},
      {x:1740,y:1040,w:80,h:80},{x:1740,y:1280,w:80,h:80},
      {x:860,y:860,w:60,h:60},{x:1480,y:860,w:60,h:60},
      {x:860,y:1480,w:60,h:60},{x:1480,y:1480,w:60,h:60},
    ],
  },

  desert: {
    name: 'Desert',
    emoji: '🏜️',
    desc: 'Open terrain, long range',
    color: '#f39c12',
    spawns: [
      {x:150,y:150},{x:2250,y:2250},{x:2250,y:150},{x:150,y:2250},
      {x:1200,y:150},{x:1200,y:2250},{x:150,y:1200},{x:2250,y:1200},
    ],
    obstacles: [
      // sparse rock formations
      {x:500,y:500,w:120,h:40},{x:560,y:460,w:40,h:120},
      {x:1800,y:500,w:120,h:40},{x:1800,y:460,w:40,h:120},
      {x:500,y:1820,w:120,h:40},{x:560,y:1820,w:40,h:120},
      {x:1800,y:1820,w:120,h:40},{x:1800,y:1820,w:40,h:120},
      // center oasis
      {x:1080,y:1080,w:240,h:30},{x:1080,y:1290,w:240,h:30},
      {x:1080,y:1080,w:30,h:240},{x:1290,y:1080,w:30,h:240},
      // mid rocks
      {x:700,y:1150,w:100,h:100},{x:1550,y:1150,w:100,h:100},
      {x:1150,y:700,w:100,h:100},{x:1150,y:1550,w:100,h:100},
      // small scattered
      {x:300,y:800,w:60,h:60},{x:2000,y:800,w:60,h:60},
      {x:300,y:1550,w:60,h:60},{x:2000,y:1550,w:60,h:60},
      {x:900,y:300,w:60,h:60},{x:1400,y:300,w:60,h:60},
      {x:900,y:2050,w:60,h:60},{x:1400,y:2050,w:60,h:60},
    ],
  },

  castle: {
    name: 'Castle',
    emoji: '🏰',
    desc: 'Rooms and corridors',
    color: '#9b59b6',
    spawns: [
      {x:160,y:160},{x:2240,y:2240},{x:2240,y:160},{x:160,y:2240},
      {x:1200,y:160},{x:1200,y:2240},{x:160,y:1200},{x:2240,y:1200},
    ],
    obstacles: [
      // outer walls with gaps
      {x:300,y:300,w:800,h:40},{x:1300,y:300,w:800,h:40},
      {x:300,y:2060,w:800,h:40},{x:1300,y:2060,w:800,h:40},
      {x:300,y:300,w:40,h:800},{x:300,y:1300,w:40,h:800},
      {x:2060,y:300,w:40,h:800},{x:2060,y:1300,w:40,h:800},
      // inner rooms
      {x:550,y:550,w:300,h:30},{x:1550,y:550,w:300,h:30},
      {x:550,y:1820,w:300,h:30},{x:1550,y:1820,w:300,h:30},
      {x:550,y:550,w:30,h:300},{x:550,y:1550,w:30,h:300},
      {x:1820,y:550,w:30,h:300},{x:1820,y:1550,w:30,h:300},
      // center keep
      {x:950,y:950,w:500,h:40},{x:950,y:1410,w:500,h:40},
      {x:950,y:950,w:40,h:200},{x:950,y:1210,w:40,h:200},
      {x:1410,y:950,w:40,h:200},{x:1410,y:1210,w:40,h:200},
      // corridors pillars
      {x:750,y:1180,w:50,h:50},{x:1600,y:1180,w:50,h:50},
      {x:1180,y:750,w:50,h:50},{x:1180,y:1600,w:50,h:50},
    ],
  },

  maze: {
    name: 'Maze',
    emoji: '🌀',
    desc: 'Tight paths, close quarters',
    color: '#1abc9c',
    spawns: [
      {x:100,y:100},{x:2300,y:2300},{x:2300,y:100},{x:100,y:2300},
      {x:1200,y:100},{x:1200,y:2300},{x:100,y:1200},{x:2300,y:1200},
    ],
    obstacles: [
      // horizontal corridors
      {x:200,y:400,w:500,h:35},{x:900,y:400,w:500,h:35},{x:1600,y:400,w:600,h:35},
      {x:200,y:700,w:300,h:35},{x:700,y:700,w:600,h:35},{x:1500,y:700,w:700,h:35},
      {x:200,y:1000,w:600,h:35},{x:1000,y:1000,w:400,h:35},{x:1600,y:1000,w:600,h:35},
      {x:200,y:1300,w:400,h:35},{x:800,y:1300,w:600,h:35},{x:1600,y:1300,w:600,h:35},
      {x:200,y:1600,w:700,h:35},{x:1100,y:1600,w:400,h:35},{x:1700,y:1600,w:500,h:35},
      {x:200,y:1900,w:500,h:35},{x:900,y:1900,w:600,h:35},{x:1700,y:1900,w:500,h:35},
      // vertical connectors
      {x:400,y:400,w:35,h:300},{x:800,y:700,w:35,h:300},{x:1200,y:400,w:35,h:300},
      {x:1600,y:700,w:35,h:300},{x:400,y:1000,w:35,h:300},{x:900,y:1300,w:35,h:300},
      {x:1400,y:1000,w:35,h:300},{x:600,y:1600,w:35,h:300},{x:1800,y:1300,w:35,h:300},
      {x:1100,y:1600,w:35,h:300},{x:400,y:1900,w:35,h:300},{x:1600,y:1600,w:35,h:300},
    ],
  },

  industrial: {
    name: 'Industrial',
    emoji: '🏗️',
    desc: 'Cover-heavy, mid range',
    color: '#e67e22',
    spawns: [
      {x:150,y:150},{x:2250,y:2250},{x:2250,y:150},{x:150,y:2250},
      {x:1200,y:150},{x:1200,y:2250},{x:150,y:1200},{x:2250,y:1200},
    ],
    obstacles: [
      // large horizontal covers
      {x:300,y:500,w:400,h:50},{x:1700,y:500,w:400,h:50},
      {x:300,y:900,w:400,h:50},{x:1700,y:900,w:400,h:50},
      {x:300,y:1300,w:400,h:50},{x:1700,y:1300,w:400,h:50},
      {x:300,y:1700,w:400,h:50},{x:1700,y:1700,w:400,h:50},
      // center machinery
      {x:900,y:800,w:600,h:50},{x:900,y:1550,w:600,h:50},
      {x:900,y:800,w:50,h:300},{x:1450,y:800,w:50,h:300},
      {x:900,y:1250,w:50,h:300},{x:1450,y:1250,w:50,h:300},
      // mid pillars
      {x:750,y:500,w:60,h:60},{x:1550,y:500,w:60,h:60},
      {x:750,y:1800,w:60,h:60},{x:1550,y:1800,w:60,h:60},
      {x:750,y:1150,w:60,h:60},{x:1550,y:1150,w:60,h:60},
      // side corridors
      {x:200,y:1150,w:35,h:400},{x:2165,y:1150,w:35,h:400},
      {x:600,y:300,w:35,h:200},{x:1750,y:300,w:35,h:200},
      {x:600,y:1900,w:35,h:200},{x:1750,y:1900,w:35,h:200},
    ],
  },
};

const MAP_IDS = Object.keys(MAPS);

// ── Round state machine ───────────────────────────────────────────────────────
// States: 'playing' | 'intermission'
let roundState = 'playing';
let currentMapId = 'arena';
let roundEndsAt = Date.now() + ROUND_DURATION_MS;
let intermissionEndsAt = 0;
let roundNumber = 1;
let voteOptions = [];    // array of mapId strings offered this intermission
let votes = {};          // socketId -> mapId
let roundWinner = null;  // { name, color, kills, score } | null

function pickVoteOptions() {
  // Pick VOTE_MAP_COUNT random maps, always include at least one that isn't current
  const others = MAP_IDS.filter(id => id !== currentMapId);
  const shuffled = others.sort(() => Math.random() - 0.5);
  const picks = shuffled.slice(0, VOTE_MAP_COUNT);
  // If we have room, add current map as "play again" option
  if (picks.length < VOTE_MAP_COUNT) picks.push(currentMapId);
  return picks;
}

function tallyVotes() {
  const counts = {};
  for (const id of voteOptions) counts[id] = 0;
  for (const mapId of Object.values(votes)) {
    if (counts[mapId] !== undefined) counts[mapId]++;
  }
  // Find winner
  let best = voteOptions[0], bestCount = -1;
  for (const [id, c] of Object.entries(counts)) {
    if (c > bestCount) { bestCount = c; best = id; }
  }
  return { winner: best, counts };
}

function startIntermission() {
  roundState = 'intermission';
  votes = {};
  voteOptions = pickVoteOptions();
  intermissionEndsAt = Date.now() + INTERMISSION_MS;

  // Find round winner (most kills)
  const pList = Object.values(players);
  roundWinner = null;
  if (pList.length > 0) {
    const top = pList.reduce((a, b) => b.kills > a.kills ? b : a, pList[0]);
    roundWinner = { name: top.name, color: top.color, kills: top.kills, score: top.score };
  }

  io.emit('intermission', {
    roundWinner,
    voteOptions: voteOptions.map(id => ({ id, ...MAPS[id], obstacles: undefined })),
    endsAt: intermissionEndsAt,
    roundNumber,
  });
}

function startRound(mapId) {
  currentMapId = mapId;
  roundNumber++;
  roundState = 'playing';
  roundEndsAt = Date.now() + ROUND_DURATION_MS;
  bullets.length = 0;

  // Reset all player scores/kills, teleport to new spawns
  for (const p of Object.values(players)) {
    p.kills = 0; p.deaths = 0; p.score = 0;
    p.hp = MAX_HP; p.alive = true; p.fireCooldown = 0;
    const sp = randomSpawnForMap(mapId);
    p.x = sp.x; p.y = sp.y;
  }
  leaderboardDirty = true;

  io.emit('newRound', {
    mapId,
    mapName: MAPS[mapId].name,
    mapEmoji: MAPS[mapId].emoji,
    mapColor: MAPS[mapId].color,
    obstacles: MAPS[mapId].obstacles,
    roundNumber,
    endsAt: roundEndsAt,
  });
}

// ── Player/bullet state ───────────────────────────────────────────────────────
const players = {};
const bullets = [];
let bulletId = 0;
let colorIdx = 0;
let cachedLeaderboard = [];
let leaderboardDirty = true;

// ── Helpers ───────────────────────────────────────────────────────────────────
function currentObstacles() { return MAPS[currentMapId].obstacles; }

function overlapsObstacle(x, y, r, obs) {
  obs = obs || currentObstacles();
  for (const o of obs) {
    const nearX = Math.max(o.x, Math.min(o.x + o.w, x));
    const nearY = Math.max(o.y, Math.min(o.y + o.h, y));
    const dx = x - nearX, dy = y - nearY;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function randomSpawnForMap(mapId) {
  const obs = MAPS[mapId].obstacles;
  const spawns = MAPS[mapId].spawns;
  // Try defined spawn points first (shuffled)
  const shuffled = spawns.slice().sort(() => Math.random() - 0.5);
  for (const sp of shuffled) {
    if (!overlapsObstacle(sp.x, sp.y, PLAYER_R + 20, obs)) return sp;
  }
  // Fallback: random
  for (let i = 0; i < 50; i++) {
    const x = 80 + Math.random() * (WORLD_W - 160);
    const y = 80 + Math.random() * (WORLD_H - 160);
    if (!overlapsObstacle(x, y, PLAYER_R + 30, obs)) return { x, y };
  }
  return { x: WORLD_W / 2, y: WORLD_H / 2 };
}

function randomSpawn() { return randomSpawnForMap(currentMapId); }

function moveWithSlide(px, py, dx, dy, r) {
  const obs = currentObstacles();
  const nx = clamp(px + dx, r, WORLD_W - r);
  const ny = clamp(py + dy, r, WORLD_H - r);
  if (!overlapsObstacle(nx, ny, r, obs)) return [nx, ny];
  if (!overlapsObstacle(clamp(px + dx, r, WORLD_W - r), py, r, obs)) return [clamp(px + dx, r, WORLD_W - r), py];
  if (!overlapsObstacle(px, clamp(py + dy, r, WORLD_H - r), r, obs)) return [px, clamp(py + dy, r, WORLD_H - r)];
  return [px, py];
}

function getLeaderboard() {
  if (!leaderboardDirty) return cachedLeaderboard;
  cachedLeaderboard = Object.values(players)
    .sort((a, b) => b.score - a.score)
    .slice(0, LEADERBOARD_SIZE)
    .map(p => ({ id: p.id, name: p.name, score: p.score, kills: p.kills, color: p.color }));
  leaderboardDirty = false;
  return cachedLeaderboard;
}

function makePlayer(id, name, ci) {
  const sp = randomSpawn();
  return {
    id, name, colorIndex: ci,
    color: COLORS[ci % COLORS.length],
    x: sp.x, y: sp.y,
    angle: 0, hp: MAX_HP,
    alive: true, respawnAt: 0,
    kills: 0, deaths: 0, score: 0,
    fireCooldown: 0, keys: {},
  };
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('ping_check', ts => socket.emit('pong_check', ts));

  socket.on('join', ({ name }) => {
    const safe = ((name || '').trim().replace(/[<>&"]/g, '').slice(0, 16)) ||
      `Player${Math.floor(Math.random() * 9999)}`;
    players[socket.id] = makePlayer(socket.id, safe, colorIdx++ % COLORS.length);

    // Send full game state to newcomer
    socket.emit('init', {
      playerId: socket.id,
      worldW: WORLD_W, worldH: WORLD_H,
      playerR: PLAYER_R,
      mapId: currentMapId,
      mapName: MAPS[currentMapId].name,
      mapEmoji: MAPS[currentMapId].emoji,
      mapColor: MAPS[currentMapId].color,
      obstacles: currentObstacles(),
      leaderboard: getLeaderboard(),
      roundState,
      roundEndsAt,
      roundNumber,
      // If joining mid-intermission, send vote state
      ...(roundState === 'intermission' ? {
        voteOptions: voteOptions.map(id => ({ id, ...MAPS[id], obstacles: undefined })),
        intermissionEndsAt,
        roundWinner,
      } : {}),
    });

    io.emit('playerCount', Object.keys(players).length);
    socket.emit('leaderboard', getLeaderboard());
  });

  socket.on('input', ({ keys, angle }) => {
    const p = players[socket.id];
    if (!p || roundState !== 'playing') return;
    p.keys = keys || {};
    if (typeof angle === 'number' && isFinite(angle)) p.angle = angle;
  });

  socket.on('shoot', ({ angle }) => {
    const p = players[socket.id];
    if (!p || !p.alive || roundState !== 'playing') return;
    if (p.fireCooldown > 0) return;
    if (bullets.length >= MAX_BULLETS) return;
    p.fireCooldown = FIRE_COOLDOWN;
    const a = (typeof angle === 'number' && isFinite(angle)) ? angle : p.angle;
    bullets.push({
      id: bulletId++,
      x: p.x + Math.cos(a) * (PLAYER_R + 6),
      y: p.y + Math.sin(a) * (PLAYER_R + 6),
      vx: Math.cos(a) * BULLET_SPEED,
      vy: Math.sin(a) * BULLET_SPEED,
      owner: socket.id,
      ownerColor: p.color,
      life: BULLET_LIFE,
    });
  });

  socket.on('vote', ({ mapId }) => {
    if (roundState !== 'intermission') return;
    if (!voteOptions.includes(mapId)) return;
    votes[socket.id] = mapId;
    // Broadcast updated vote counts to everyone
    io.emit('voteUpdate', tallyVotes().counts);
  });

  // ── Chat ────────────────────────────────────────────────────────────────────
  let lastChatTime = 0;
  socket.on('chat', ({ msg }) => {
    const p = players[socket.id];
    if (!p) return;
    const now = Date.now();
    if (now - lastChatTime < 1000) return;
    lastChatTime = now;
    const clean = (msg || '').toString()
      .replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))
      .trim().slice(0, 64);
    if (!clean) return;
    io.emit('chat', { id: socket.id, name: p.name, color: p.color, msg: clean });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) { leaderboardDirty = true; delete players[socket.id]; }
    delete votes[socket.id];
    io.emit('playerLeft', socket.id);
    io.emit('playerCount', Object.keys(players).length);
  });
});

// ── Round timer ───────────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  if (roundState === 'playing') {
    if (now >= roundEndsAt) startIntermission();
    else {
      // Broadcast time remaining every second (not every tick — too noisy)
      // Done via state broadcast below
    }
  } else if (roundState === 'intermission') {
    if (now >= intermissionEndsAt) {
      const { winner } = tallyVotes();
      startRound(winner);
    }
  }
}, 500);

// ── Game tick ─────────────────────────────────────────────────────────────────
setInterval(() => {
  const pList = Object.values(players);
  if (pList.length === 0) return;
  const now = Date.now();

  if (roundState === 'playing') {
    // Respawn
    for (const p of pList) {
      if (!p.alive && now >= p.respawnAt) {
        const sp = randomSpawn();
        p.x = sp.x; p.y = sp.y; p.hp = MAX_HP; p.alive = true;
      }
    }

    // Move players
    for (const p of pList) {
      if (!p.alive) continue;
      if (p.fireCooldown > 0) p.fireCooldown--;
      const k = p.keys;
      let dx = 0, dy = 0;
      if (k.up)    dy -= 1;
      if (k.down)  dy += 1;
      if (k.left)  dx -= 1;
      if (k.right) dx += 1;
      if (dx || dy) {
        const len = Math.sqrt(dx * dx + dy * dy);
        [p.x, p.y] = moveWithSlide(p.x, p.y, dx / len * PLAYER_SPEED, dy / len * PLAYER_SPEED, PLAYER_R);
      }
    }

    // Bullets
    const obs = currentObstacles();
    for (const b of bullets) {
      b.x += b.vx; b.y += b.vy; b.life--;
      if (b.life <= 0 || b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) { b.life = 0; continue; }
      if (overlapsObstacle(b.x, b.y, BULLET_R, obs)) { b.life = 0; continue; }
      for (const p of pList) {
        if (!p.alive || p.id === b.owner) continue;
        const dx = p.x - b.x, dy = p.y - b.y;
        if (dx * dx + dy * dy < (PLAYER_R + BULLET_R) ** 2) {
          b.life = 0; p.hp -= DAMAGE;
          io.to(p.id).emit('damaged', { hp: Math.max(0, p.hp) });
          if (p.hp <= 0) {
            p.hp = 0; p.alive = false; p.deaths++;
            p.respawnAt = now + RESPAWN_MS;
            const shooter = players[b.owner];
            if (shooter) {
              shooter.kills++; shooter.score += 100;
              leaderboardDirty = true;
              io.emit('kill', { killerName: shooter.name, killerColor: shooter.color, victimName: p.name, victimColor: p.color });
              io.emit('leaderboard', getLeaderboard());
            }
            io.emit('died', { victimId: p.id, respawnIn: RESPAWN_MS });
          }
          break;
        }
      }
    }
    for (let i = bullets.length - 1; i >= 0; i--) if (bullets[i].life <= 0) bullets.splice(i, 1);
  }

  // Broadcast state + timer every tick
  io.emit('state', {
    players: pList.map(p => ({
      id: p.id, x: p.x | 0, y: p.y | 0,
      angle: Math.round(p.angle * 100) / 100,
      hp: p.hp, alive: p.alive,
      color: p.color, name: p.name,
      kills: p.kills, score: p.score,
    })),
    bullets: roundState === 'playing' ? bullets.map(b => ({ id: b.id, x: b.x | 0, y: b.y | 0, c: b.ownerColor })) : [],
    roundState,
    timeLeft: roundState === 'playing'
      ? Math.max(0, roundEndsAt - now)
      : Math.max(0, intermissionEndsAt - now),
  });

}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Arena.io — Rounds on port ${PORT}`));
SERVEREOF
echo "server.js done — $(wc -l < /home/claude/arena-io-v2/server.js) lines"
