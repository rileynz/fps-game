const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Reduce overhead on low-bandwidth clients
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
const BULLET_LIFE = 180;        // ticks (~3s at 60tps)
const PLAYER_SPEED = 4.0;
const RESPAWN_MS = 3000;
const DAMAGE = 25;              // 4 shots to kill
const MAX_HP = 100;
const FIRE_COOLDOWN = 10;       // ticks between shots
const SHOOT_RATE_LIMIT = 8;     // min ticks between shots (server enforced)
const MAX_BULLETS = 300;        // cap total bullets to protect server
const LEADERBOARD_SIZE = 10;

const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e8c','#00bcd4','#8bc34a',
];

// ── Obstacles ─────────────────────────────────────────────────────────────────
const OBSTACLES = [
  // center fort
  {x:1100,y:1100,w:200,h:40},{x:1100,y:1260,w:200,h:40},
  {x:1060,y:1140,w:40,h:120},{x:1300,y:1140,w:40,h:120},
  // corner L-shapes
  {x:350,y:350,w:140,h:35},{x:350,y:350,w:35,h:140},
  {x:1915,y:350,w:140,h:35},{x:2015,y:350,w:35,h:140},
  {x:350,y:2015,w:35,h:140},{x:350,y:2015,w:140,h:35},
  {x:1915,y:2015,w:140,h:35},{x:2015,y:1875,w:35,h:140},
  // mid walls
  {x:250,y:1150,w:220,h:35},{x:250,y:1215,w:35,h:80},
  {x:1930,y:1150,w:220,h:35},{x:2115,y:1150,w:35,h:80},
  {x:1150,y:250,w:35,h:220},{x:1215,y:250,w:80,h:35},
  {x:1150,y:1930,w:35,h:220},{x:1150,y:2115,w:80,h:35},
  // scattered boxes
  {x:680,y:680,w:80,h:80},{x:1640,y:680,w:80,h:80},
  {x:680,y:1640,w:80,h:80},{x:1640,y:1640,w:80,h:80},
  {x:1040,y:580,w:80,h:80},{x:1280,y:580,w:80,h:80},
  {x:1040,y:1740,w:80,h:80},{x:1280,y:1740,w:80,h:80},
  {x:580,y:1040,w:80,h:80},{x:580,y:1280,w:80,h:80},
  {x:1740,y:1040,w:80,h:80},{x:1740,y:1280,w:80,h:80},
  // diagonal corridor blockers
  {x:860,y:860,w:60,h:60},{x:1480,y:860,w:60,h:60},
  {x:860,y:1480,w:60,h:60},{x:1480,y:1480,w:60,h:60},
];

// ── State ─────────────────────────────────────────────────────────────────────
const players = {};
const bullets = [];
let bulletId = 0;
let colorIdx = 0;
let cachedLeaderboard = [];
let leaderboardDirty = true;

// ── Helpers ───────────────────────────────────────────────────────────────────
function overlapsObstacle(x, y, r) {
  for (const o of OBSTACLES) {
    const nearX = Math.max(o.x, Math.min(o.x + o.w, x));
    const nearY = Math.max(o.y, Math.min(o.y + o.h, y));
    const dx = x - nearX, dy = y - nearY;
    if (dx * dx + dy * dy < r * r) return true;
  }
  return false;
}

function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

function randomSpawn() {
  for (let i = 0; i < 50; i++) {
    const x = 80 + Math.random() * (WORLD_W - 160);
    const y = 80 + Math.random() * (WORLD_H - 160);
    if (!overlapsObstacle(x, y, PLAYER_R + 30)) return { x, y };
  }
  return { x: WORLD_W / 2, y: WORLD_H / 2 };
}

function moveSlide(px, py, dx, dy, r) {
  let nx = clamp(px + dx, r, WORLD_W - r);
  let ny = clamp(py + dy, r, WORLD_H - r);
  if (!overlapsObstacle(nx, py, r)) return [nx, py + dy <= WORLD_H - r ? clamp(py + dy, r, WORLD_H - r) : py];
  if (!overlapsObstacle(px, ny, r)) return [clamp(px + dx, r, WORLD_W - r) <= WORLD_W - r ? px : px, ny];
  return [px, py];
}

function moveWithSlide(px, py, dx, dy, r) {
  let nx = clamp(px + dx, r, WORLD_W - r);
  let ny = clamp(py + dy, r, WORLD_H - r);
  if (!overlapsObstacle(nx, ny, r)) return [nx, ny];
  if (!overlapsObstacle(px + dx, py, r)) return [clamp(px + dx, r, WORLD_W - r), py];
  if (!overlapsObstacle(px, py + dy, r)) return [px, clamp(py + dy, r, WORLD_H - r)];
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
    lastShot: 0,   // FIX #4: server-side rate limiting
  };
}

// ── Socket ────────────────────────────────────────────────────────────────────
// FIX #1: single connection handler, ping inside it
io.on('connection', socket => {

  // Ping — FIX #1
  socket.on('ping_check', ts => socket.emit('pong_check', ts));

  socket.on('join', ({ name }) => {
    const safe = ((name || '').trim().replace(/[<>&"]/g, '').slice(0, 16)) ||
      `Player${Math.floor(Math.random() * 9999)}`;
    players[socket.id] = makePlayer(socket.id, safe, colorIdx++ % COLORS.length);

    socket.emit('init', {
      playerId: socket.id,
      worldW: WORLD_W, worldH: WORLD_H,
      obstacles: OBSTACLES,
      playerR: PLAYER_R,
      leaderboard: getLeaderboard(),
    });
    io.emit('playerCount', Object.keys(players).length);
    // FIX: send leaderboard to new joiner immediately
    socket.emit('leaderboard', getLeaderboard());
  });

  socket.on('input', ({ keys, angle }) => {
    const p = players[socket.id];
    if (!p) return;
    p.keys = keys || {};
    if (typeof angle === 'number' && isFinite(angle)) p.angle = angle;
  });

  // FIX #4: server-side shoot rate limiting
  socket.on('shoot', ({ angle }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (p.fireCooldown > 0) return;
    if (bullets.length >= MAX_BULLETS) return; // FIX #4b: cap bullets
    p.fireCooldown = FIRE_COOLDOWN;
    p.lastShot = now;
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

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      leaderboardDirty = true;
      delete players[socket.id];
    }
    // FIX #5: broadcast immediately so clients remove them
    io.emit('playerLeft', socket.id);
    io.emit('playerCount', Object.keys(players).length);
  });
});

// ── Game tick ─────────────────────────────────────────────────────────────────
setInterval(() => {
  const pList = Object.values(players);
  // FIX #2: skip if nobody playing
  if (pList.length === 0) return;

  const now = Date.now();

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

  // Move & collide bullets
  for (const b of bullets) {
    b.x += b.vx; b.y += b.vy; b.life--;
    if (b.life <= 0 || b.x < 0 || b.x > WORLD_W || b.y < 0 || b.y > WORLD_H) { b.life = 0; continue; }
    if (overlapsObstacle(b.x, b.y, BULLET_R)) { b.life = 0; continue; }
    for (const p of pList) {
      if (!p.alive || p.id === b.owner) continue;
      const dx = p.x - b.x, dy = p.y - b.y;
      if (dx * dx + dy * dy < (PLAYER_R + BULLET_R) * (PLAYER_R + BULLET_R)) {
        b.life = 0;
        p.hp -= DAMAGE;
        io.to(p.id).emit('damaged', { hp: Math.max(0, p.hp) });
        if (p.hp <= 0) {
          p.hp = 0; p.alive = false; p.deaths++;
          p.respawnAt = now + RESPAWN_MS;
          const shooter = players[b.owner];
          if (shooter) {
            shooter.kills++; shooter.score += 100;
            leaderboardDirty = true;
            io.emit('kill', {
              killerName: shooter.name, killerColor: shooter.color,
              victimName: p.name, victimColor: p.color,
            });
            // FIX #3: leaderboard only on kill, using cache
            io.emit('leaderboard', getLeaderboard());
          }
          io.emit('died', { victimId: p.id, respawnIn: RESPAWN_MS });
        }
        break;
      }
    }
  }

  // Remove dead bullets efficiently
  for (let i = bullets.length - 1; i >= 0; i--) {
    if (bullets[i].life <= 0) bullets.splice(i, 1);
  }

  // Broadcast state — round positions to save bytes
  io.emit('state', {
    players: pList.map(p => ({
      id: p.id, x: p.x | 0, y: p.y | 0,
      angle: Math.round(p.angle * 100) / 100,
      hp: p.hp, alive: p.alive,
      color: p.color, name: p.name,
      kills: p.kills, score: p.score,
    })),
    bullets: bullets.map(b => ({ id: b.id, x: b.x | 0, y: b.y | 0, c: b.ownerColor })),
  });

}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Arena.io v2 on port ${PORT}`));
