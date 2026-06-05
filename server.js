const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors:{origin:'*'}, pingTimeout:10000, pingInterval:5000 });
app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ─────────────────────────────────────────────────────────────────
const WORLD_W = 2400, WORLD_H = 2400;
const PHYSICS_MS   = 1000 / 60;
const BROADCAST_MS = 1000 / 20;
const VIEWPORT_PAD = 1400;
const PLAYER_R = 15, BULLET_R = 5;
const BULLET_SPEED = 10, BULLET_LIFE = 180;
const PLAYER_SPEED = 4.0;
const RESPAWN_MS = 3000;
const DAMAGE = 25, MAX_HP = 100;
const FIRE_COOLDOWN = 10, MAX_BULLETS = 300;
const LEADERBOARD_SIZE = 10;
const WEEKLY_LB_SIZE = 10;
const ROUND_DURATION_MS = 3 * 60 * 1000;
const INTERMISSION_MS   = 15 * 1000;
const VOTE_MAP_COUNT = 3;
const TDM_KILLS_TO_WIN = 20;
const FFA_MAX = 20;
const TDM_MAX = 16;
const TEAM_RED_COLOR  = '#e74c3c';
const TEAM_BLUE_COLOR = '#3498db';
const FFA_COLORS = [
  '#e74c3c','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e8c','#00bcd4','#8bc34a','#ff6b6b',
];

// ── Weekly leaderboard ────────────────────────────────────────────────────────
// Stored in weekly.json so it survives server restarts.
// Structure: { weekKey: 'YYYY-WW', entries: [{name, kills, score, color}] }
const WEEKLY_FILE = path.join(__dirname, 'weekly.json');

function getWeekKey() {
  const now = new Date();
  // ISO week number
  const jan4 = new Date(now.getFullYear(), 0, 4);
  const startOfWeek = new Date(jan4);
  startOfWeek.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1);
  const weekNum = Math.ceil(((now - startOfWeek) / 86400000 + 1) / 7);
  return `${now.getFullYear()}-W${String(weekNum).padStart(2,'0')}`;
}

function loadWeekly() {
  try {
    if (fs.existsSync(WEEKLY_FILE)) {
      const data = JSON.parse(fs.readFileSync(WEEKLY_FILE, 'utf8'));
      // If it's a new week, reset
      if (data.weekKey !== getWeekKey()) {
        return { weekKey: getWeekKey(), entries: [], prevWeek: data };
      }
      return data;
    }
  } catch(e) { console.error('weekly load error:', e.message); }
  return { weekKey: getWeekKey(), entries: [], prevWeek: null };
}

function saveWeekly() {
  try { fs.writeFileSync(WEEKLY_FILE, JSON.stringify(weekly, null, 2)); }
  catch(e) { console.error('weekly save error:', e.message); }
}

let weekly = loadWeekly();

// Check for week reset every hour
setInterval(() => {
  const key = getWeekKey();
  if (weekly.weekKey !== key) {
    console.log(`New week detected (${key}), resetting weekly leaderboard`);
    weekly = { weekKey: key, entries: [], prevWeek: { weekKey: weekly.weekKey, entries: weekly.entries } };
    saveWeekly();
    io.emit('weeklyLeaderboard', getWeeklyLB());
  }
}, 60 * 60 * 1000);

function getWeeklyLB() {
  return {
    weekKey: weekly.weekKey,
    entries: weekly.entries.slice(0, WEEKLY_LB_SIZE),
    prevWeek: weekly.prevWeek ? {
      weekKey: weekly.prevWeek.weekKey,
      entries: (weekly.prevWeek.entries || []).slice(0, WEEKLY_LB_SIZE),
    } : null,
    resetsAt: getNextMonday(),
  };
}

function getNextMonday() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon...
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
}

// Called every time a player gets a kill
function recordWeeklyKill(name, color, killsThisRound, scoreThisRound) {
  // Find existing entry by name (case-insensitive)
  const key = name.toLowerCase();
  const idx = weekly.entries.findIndex(e => e.name.toLowerCase() === key);

  if (idx >= 0) {
    weekly.entries[idx].kills += killsThisRound;
    weekly.entries[idx].score += scoreThisRound;
    weekly.entries[idx].color  = color; // update colour in case they changed
  } else {
    weekly.entries.push({ name, color, kills: killsThisRound, score: scoreThisRound });
  }

  // Re-sort by kills descending, score as tiebreak
  weekly.entries.sort((a,b) => b.kills !== a.kills ? b.kills - a.kills : b.score - a.score);
  // Keep only top 100 to prevent unbounded growth
  if (weekly.entries.length > 100) weekly.entries = weekly.entries.slice(0, 100);
}

// ── Maps ──────────────────────────────────────────────────────────────────────
const MAPS = {
  arena:{name:'Arena',emoji:'⚔️',desc:'Classic symmetric arena',color:'#3498db',
    spawns:[{x:200,y:200},{x:2200,y:2200},{x:2200,y:200},{x:200,y:2200},{x:1200,y:200},{x:1200,y:2200},{x:200,y:1200},{x:2200,y:1200}],
    redSpawns:[{x:200,y:200},{x:400,y:400},{x:200,y:600},{x:600,y:200}],
    blueSpawns:[{x:2200,y:2200},{x:2000,y:2000},{x:2200,y:1800},{x:1800,y:2200}],
    obstacles:[
      {x:1100,y:1100,w:200,h:40},{x:1100,y:1260,w:200,h:40},{x:1060,y:1140,w:40,h:120},{x:1300,y:1140,w:40,h:120},
      {x:350,y:350,w:140,h:35},{x:350,y:350,w:35,h:140},{x:1915,y:350,w:140,h:35},{x:2015,y:350,w:35,h:140},
      {x:350,y:2015,w:35,h:140},{x:350,y:2015,w:140,h:35},{x:1915,y:2015,w:140,h:35},{x:2015,y:1875,w:35,h:140},
      {x:250,y:1150,w:220,h:35},{x:250,y:1215,w:35,h:80},{x:1930,y:1150,w:220,h:35},{x:2115,y:1150,w:35,h:80},
      {x:1150,y:250,w:35,h:220},{x:1215,y:250,w:80,h:35},{x:1150,y:1930,w:35,h:220},{x:1150,y:2115,w:80,h:35},
      {x:680,y:680,w:80,h:80},{x:1640,y:680,w:80,h:80},{x:680,y:1640,w:80,h:80},{x:1640,y:1640,w:80,h:80},
      {x:1040,y:580,w:80,h:80},{x:1280,y:580,w:80,h:80},{x:1040,y:1740,w:80,h:80},{x:1280,y:1740,w:80,h:80},
      {x:580,y:1040,w:80,h:80},{x:580,y:1280,w:80,h:80},{x:1740,y:1040,w:80,h:80},{x:1740,y:1280,w:80,h:80},
      {x:860,y:860,w:60,h:60},{x:1480,y:860,w:60,h:60},{x:860,y:1480,w:60,h:60},{x:1480,y:1480,w:60,h:60},
    ]},
  desert:{name:'Desert',emoji:'🏜️',desc:'Open terrain, long range',color:'#f39c12',
    spawns:[{x:150,y:150},{x:2250,y:2250},{x:2250,y:150},{x:150,y:2250},{x:1200,y:150},{x:1200,y:2250},{x:150,y:1200},{x:2250,y:1200}],
    redSpawns:[{x:150,y:150},{x:350,y:350},{x:150,y:550},{x:550,y:150}],
    blueSpawns:[{x:2250,y:2250},{x:2050,y:2050},{x:2250,y:1850},{x:1850,y:2250}],
    obstacles:[
      {x:500,y:500,w:120,h:40},{x:560,y:460,w:40,h:120},{x:1800,y:500,w:120,h:40},{x:1800,y:460,w:40,h:120},
      {x:500,y:1820,w:120,h:40},{x:560,y:1820,w:40,h:120},{x:1800,y:1820,w:120,h:40},{x:1800,y:1820,w:40,h:120},
      {x:1080,y:1080,w:240,h:30},{x:1080,y:1290,w:240,h:30},{x:1080,y:1080,w:30,h:240},{x:1290,y:1080,w:30,h:240},
      {x:700,y:1150,w:100,h:100},{x:1550,y:1150,w:100,h:100},{x:1150,y:700,w:100,h:100},{x:1150,y:1550,w:100,h:100},
      {x:300,y:800,w:60,h:60},{x:2000,y:800,w:60,h:60},{x:300,y:1550,w:60,h:60},{x:2000,y:1550,w:60,h:60},
      {x:900,y:300,w:60,h:60},{x:1400,y:300,w:60,h:60},{x:900,y:2050,w:60,h:60},{x:1400,y:2050,w:60,h:60},
    ]},
  castle:{name:'Castle',emoji:'🏰',desc:'Rooms and corridors',color:'#9b59b6',
    spawns:[{x:160,y:160},{x:2240,y:2240},{x:2240,y:160},{x:160,y:2240},{x:1200,y:160},{x:1200,y:2240},{x:160,y:1200},{x:2240,y:1200}],
    redSpawns:[{x:160,y:160},{x:360,y:360},{x:160,y:560},{x:560,y:160}],
    blueSpawns:[{x:2240,y:2240},{x:2040,y:2040},{x:2240,y:1840},{x:1840,y:2240}],
    obstacles:[
      {x:300,y:300,w:800,h:40},{x:1300,y:300,w:800,h:40},{x:300,y:2060,w:800,h:40},{x:1300,y:2060,w:800,h:40},
      {x:300,y:300,w:40,h:800},{x:300,y:1300,w:40,h:800},{x:2060,y:300,w:40,h:800},{x:2060,y:1300,w:40,h:800},
      {x:550,y:550,w:300,h:30},{x:1550,y:550,w:300,h:30},{x:550,y:1820,w:300,h:30},{x:1550,y:1820,w:300,h:30},
      {x:550,y:550,w:30,h:300},{x:550,y:1550,w:30,h:300},{x:1820,y:550,w:30,h:300},{x:1820,y:1550,w:30,h:300},
      {x:950,y:950,w:500,h:40},{x:950,y:1410,w:500,h:40},{x:950,y:950,w:40,h:200},{x:950,y:1210,w:40,h:200},
      {x:1410,y:950,w:40,h:200},{x:1410,y:1210,w:40,h:200},
      {x:750,y:1180,w:50,h:50},{x:1600,y:1180,w:50,h:50},{x:1180,y:750,w:50,h:50},{x:1180,y:1600,w:50,h:50},
    ]},
  maze:{name:'Maze',emoji:'🌀',desc:'Tight paths, close quarters',color:'#1abc9c',
    spawns:[{x:100,y:100},{x:2300,y:2300},{x:2300,y:100},{x:100,y:2300},{x:1200,y:100},{x:1200,y:2300},{x:100,y:1200},{x:2300,y:1200}],
    redSpawns:[{x:100,y:100},{x:300,y:300},{x:100,y:500},{x:500,y:100}],
    blueSpawns:[{x:2300,y:2300},{x:2100,y:2100},{x:2300,y:1900},{x:1900,y:2300}],
    obstacles:[
      {x:200,y:400,w:500,h:35},{x:900,y:400,w:500,h:35},{x:1600,y:400,w:600,h:35},
      {x:200,y:700,w:300,h:35},{x:700,y:700,w:600,h:35},{x:1500,y:700,w:700,h:35},
      {x:200,y:1000,w:600,h:35},{x:1000,y:1000,w:400,h:35},{x:1600,y:1000,w:600,h:35},
      {x:200,y:1300,w:400,h:35},{x:800,y:1300,w:600,h:35},{x:1600,y:1300,w:600,h:35},
      {x:200,y:1600,w:700,h:35},{x:1100,y:1600,w:400,h:35},{x:1700,y:1600,w:500,h:35},
      {x:200,y:1900,w:500,h:35},{x:900,y:1900,w:600,h:35},{x:1700,y:1900,w:500,h:35},
      {x:400,y:400,w:35,h:300},{x:800,y:700,w:35,h:300},{x:1200,y:400,w:35,h:300},
      {x:1600,y:700,w:35,h:300},{x:400,y:1000,w:35,h:300},{x:900,y:1300,w:35,h:300},
      {x:1400,y:1000,w:35,h:300},{x:600,y:1600,w:35,h:300},{x:1800,y:1300,w:35,h:300},
      {x:1100,y:1600,w:35,h:300},{x:400,y:1900,w:35,h:300},{x:1600,y:1600,w:35,h:300},
    ]},
  industrial:{name:'Industrial',emoji:'🏗️',desc:'Cover-heavy, mid range',color:'#e67e22',
    spawns:[{x:150,y:150},{x:2250,y:2250},{x:2250,y:150},{x:150,y:2250},{x:1200,y:150},{x:1200,y:2250},{x:150,y:1200},{x:2250,y:1200}],
    redSpawns:[{x:150,y:150},{x:350,y:350},{x:150,y:550},{x:550,y:150}],
    blueSpawns:[{x:2250,y:2250},{x:2050,y:2050},{x:2250,y:1850},{x:1850,y:2250}],
    obstacles:[
      {x:300,y:500,w:400,h:50},{x:1700,y:500,w:400,h:50},{x:300,y:900,w:400,h:50},{x:1700,y:900,w:400,h:50},
      {x:300,y:1300,w:400,h:50},{x:1700,y:1300,w:400,h:50},{x:300,y:1700,w:400,h:50},{x:1700,y:1700,w:400,h:50},
      {x:900,y:800,w:600,h:50},{x:900,y:1550,w:600,h:50},{x:900,y:800,w:50,h:300},{x:1450,y:800,w:50,h:300},
      {x:900,y:1250,w:50,h:300},{x:1450,y:1250,w:50,h:300},
      {x:750,y:500,w:60,h:60},{x:1550,y:500,w:60,h:60},{x:750,y:1800,w:60,h:60},{x:1550,y:1800,w:60,h:60},
      {x:750,y:1150,w:60,h:60},{x:1550,y:1150,w:60,h:60},
      {x:200,y:1150,w:35,h:400},{x:2165,y:1150,w:35,h:400},
      {x:600,y:300,w:35,h:200},{x:1750,y:300,w:35,h:200},{x:600,y:1900,w:35,h:200},{x:1750,y:1900,w:35,h:200},
    ]},
};
const MAP_IDS = Object.keys(MAPS);

// ── Room factory ──────────────────────────────────────────────────────────────
const rooms = { ffa:{}, tdm:{} };

function createRoom(mode) {
  const id = Math.random().toString(36).substr(2,6).toUpperCase();
  const room = {
    id, mode,
    players:{}, bullets:[], roster:{},
    bulletId:0, roundState:'playing',
    currentMapId:'arena',
    roundEndsAt:Date.now()+ROUND_DURATION_MS,
    intermissionEndsAt:0, roundNumber:1,
    voteOptions:[], votes:{}, roundWinner:null,
    teamKills:{red:0,blue:0},
    leaderboardDirty:true, cachedLeaderboard:[],
    colorIdx:0, playerCountTimer:null,
  };
  rooms[mode][id]=room;
  return room;
}

function findRoom(mode) {
  const max=mode==='tdm'?TDM_MAX:FFA_MAX;
  for (const r of Object.values(rooms[mode])) {
    if (Object.keys(r.players).length<max) return r;
  }
  return createRoom(mode);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(v,lo,hi){ return v<lo?lo:v>hi?hi:v; }

function overlapsObstacle(x,y,r,obs) {
  for (const o of obs) {
    const nx=Math.max(o.x,Math.min(o.x+o.w,x)),ny=Math.max(o.y,Math.min(o.y+o.h,y));
    const dx=x-nx,dy=y-ny;
    if (dx*dx+dy*dy<r*r) return true;
  }
  return false;
}

function moveWithSlide(px,py,dx,dy,r,obs) {
  const nx=clamp(px+dx,r,WORLD_W-r),ny=clamp(py+dy,r,WORLD_H-r);
  if (!overlapsObstacle(nx,ny,r,obs)) return [nx,ny];
  if (!overlapsObstacle(clamp(px+dx,r,WORLD_W-r),py,r,obs)) return [clamp(px+dx,r,WORLD_W-r),py];
  if (!overlapsObstacle(px,clamp(py+dy,r,WORLD_H-r),r,obs)) return [px,clamp(py+dy,r,WORLD_H-r)];
  return [px,py];
}

function inViewport(px,py,vx,vy){ return Math.abs(px-vx)<VIEWPORT_PAD&&Math.abs(py-vy)<VIEWPORT_PAD; }
function currentObs(room){ return MAPS[room.currentMapId].obstacles; }

function randomSpawnForMap(mapId,team) {
  const map=MAPS[mapId],obs=map.obstacles;
  const spawns=(team==='red'&&map.redSpawns)?map.redSpawns
              :(team==='blue'&&map.blueSpawns)?map.blueSpawns:map.spawns;
  const shuffled=spawns.slice().sort(()=>Math.random()-.5);
  for (const sp of shuffled) if (!overlapsObstacle(sp.x,sp.y,PLAYER_R+20,obs)) return sp;
  for (let i=0;i<50;i++) {
    const x=80+Math.random()*(WORLD_W-160),y=80+Math.random()*(WORLD_H-160);
    if (!overlapsObstacle(x,y,PLAYER_R+30,obs)) return {x,y};
  }
  return {x:WORLD_W/2,y:WORLD_H/2};
}

function assignTeam(room) {
  const pList=Object.values(room.players);
  const reds=pList.filter(p=>p.team==='red').length;
  const blues=pList.filter(p=>p.team==='blue').length;
  return reds<=blues?'red':'blue';
}

function makePlayer(id,name,room) {
  const mode=room.mode;
  const team=mode==='tdm'?assignTeam(room):null;
  const color=mode==='tdm'?(team==='red'?TEAM_RED_COLOR:TEAM_BLUE_COLOR):FFA_COLORS[room.colorIdx++%FFA_COLORS.length];
  const sp=randomSpawnForMap(room.currentMapId,team);
  return {
    id,name,team,color,
    x:sp.x,y:sp.y,angle:0,
    hp:MAX_HP,alive:true,respawnAt:0,
    kills:0,deaths:0,score:0,
    fireCooldown:0,keys:{},
  };
}

function getLeaderboard(room) {
  if (!room.leaderboardDirty) return room.cachedLeaderboard;
  room.cachedLeaderboard=Object.values(room.players)
    .sort((a,b)=>b.score-a.score).slice(0,LEADERBOARD_SIZE)
    .map(p=>({id:p.id,name:p.name,score:p.score,kills:p.kills,color:p.color,team:p.team}));
  room.leaderboardDirty=false;
  return room.cachedLeaderboard;
}

function roomIO(room){ return io.to(`room:${room.id}`); }

function schedulePlayerCount(room) {
  if (room.playerCountTimer) return;
  room.playerCountTimer=setTimeout(()=>{
    roomIO(room).emit('playerCount',Object.keys(room.players).length);
    room.playerCountTimer=null;
  },200);
}

// ── Round management ──────────────────────────────────────────────────────────
function pickVoteOptions(room) {
  const others=MAP_IDS.filter(id=>id!==room.currentMapId).sort(()=>Math.random()-.5);
  const picks=others.slice(0,VOTE_MAP_COUNT);
  if (picks.length<VOTE_MAP_COUNT) picks.push(room.currentMapId);
  return picks;
}

function tallyVotes(room) {
  const counts={};
  for (const id of room.voteOptions) counts[id]=0;
  for (const mapId of Object.values(room.votes)) if(counts[mapId]!==undefined) counts[mapId]++;
  let best=room.voteOptions[0]||'arena',bestCount=-1;
  for (const [id,c] of Object.entries(counts)) if(c>bestCount){bestCount=c;best=id;}
  return {winner:best,counts};
}

function startIntermission(room) {
  room.roundState='intermission';
  room.votes={};
  room.voteOptions=pickVoteOptions(room);
  room.intermissionEndsAt=Date.now()+INTERMISSION_MS;

  // ── Record round stats to weekly leaderboard ──────────────────────────────
  for (const p of Object.values(room.players)) {
    if (p.kills > 0) {
      recordWeeklyKill(p.name, p.color, p.kills, p.score);
    }
  }
  saveWeekly();
  // Broadcast updated weekly to everyone in this room
  roomIO(room).emit('weeklyLeaderboard', getWeeklyLB());

  const pList=Object.values(room.players);
  room.roundWinner=null;
  if (room.mode==='tdm') {
    const winTeam=room.teamKills.red>=room.teamKills.blue?'red':'blue';
    const tied=room.teamKills.red===room.teamKills.blue;
    room.roundWinner={type:'team',team:winTeam,color:winTeam==='red'?TEAM_RED_COLOR:TEAM_BLUE_COLOR,redKills:room.teamKills.red,blueKills:room.teamKills.blue,tied};
  } else {
    if (pList.length>0) {
      const top=pList.reduce((a,b)=>b.kills>a.kills?b:a,pList[0]);
      room.roundWinner={type:'player',name:top.name,color:top.color,kills:top.kills,score:top.score};
    }
  }

  roomIO(room).emit('intermission',{
    roundWinner:room.roundWinner,
    voteOptions:room.voteOptions.map(id=>({id,...MAPS[id],obstacles:undefined})),
    endsAt:room.intermissionEndsAt,roundNumber:room.roundNumber,mode:room.mode,
  });
}

function startRound(room,mapId) {
  room.currentMapId=mapId;room.roundNumber++;
  room.roundState='playing';room.roundEndsAt=Date.now()+ROUND_DURATION_MS;
  room.bullets.length=0;room.teamKills={red:0,blue:0};
  for (const p of Object.values(room.players)) {
    p.kills=0;p.deaths=0;p.score=0;p.hp=MAX_HP;p.alive=true;p.fireCooldown=0;
    const sp=randomSpawnForMap(mapId,p.team);p.x=sp.x;p.y=sp.y;
  }
  room.leaderboardDirty=true;
  roomIO(room).emit('newRound',{
    mapId,mapName:MAPS[mapId].name,mapEmoji:MAPS[mapId].emoji,
    mapColor:MAPS[mapId].color,obstacles:MAPS[mapId].obstacles,
    roundNumber:room.roundNumber,endsAt:room.roundEndsAt,
    mode:room.mode,teamKills:room.teamKills,
  });
}

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoom=null;

  socket.on('ping_check',ts=>socket.emit('pong_check',ts));

  socket.on('join',({name,mode:wantMode})=>{
    const mode=wantMode==='tdm'?'tdm':'ffa';
    const room=findRoom(mode);
    myRoom=room;
    const safe=((name||'').trim().replace(/[<>&"]/g,'').slice(0,16))||`Player${Math.floor(Math.random()*9999)}`;
    const p=makePlayer(socket.id,safe,room);
    room.players[socket.id]=p;
    room.roster[socket.id]={name:p.name,color:p.color,team:p.team};
    socket.join(`room:${room.id}`);
    socket.to(`room:${room.id}`).emit('rosterAdd',{id:socket.id,name:p.name,color:p.color,team:p.team});
    socket.emit('init',{
      playerId:socket.id,worldW:WORLD_W,worldH:WORLD_H,playerR:PLAYER_R,
      mapId:room.currentMapId,mapName:MAPS[room.currentMapId].name,
      mapEmoji:MAPS[room.currentMapId].emoji,mapColor:MAPS[room.currentMapId].color,
      obstacles:currentObs(room),leaderboard:getLeaderboard(room),
      roundState:room.roundState,roundEndsAt:room.roundEndsAt,roundNumber:room.roundNumber,
      roster:room.roster,mode,myTeam:p.team,myColor:p.color,
      teamKills:room.teamKills,tdmKillsToWin:TDM_KILLS_TO_WIN,
      weeklyLeaderboard:getWeeklyLB(), // ← send weekly on join
      ...(room.roundState==='intermission'?{
        voteOptions:room.voteOptions.map(id=>({id,...MAPS[id],obstacles:undefined})),
        intermissionEndsAt:room.intermissionEndsAt,roundWinner:room.roundWinner,
      }:{}),
    });
    schedulePlayerCount(room);
  });

  socket.on('input',({keys,angle})=>{
    if (!myRoom) return;
    const p=myRoom.players[socket.id];
    if (!p||myRoom.roundState!=='playing') return;
    p.keys=keys||{};
    if (typeof angle==='number'&&isFinite(angle)) p.angle=angle;
  });

  socket.on('shoot',({angle})=>{
    if (!myRoom) return;
    const p=myRoom.players[socket.id];
    if (!p||!p.alive||myRoom.roundState!=='playing') return;
    if (p.fireCooldown>0||myRoom.bullets.length>=MAX_BULLETS) return;
    p.fireCooldown=FIRE_COOLDOWN;
    const a=(typeof angle==='number'&&isFinite(angle))?angle:p.angle;
    myRoom.bullets.push({
      id:myRoom.bulletId++,
      x:p.x+Math.cos(a)*(PLAYER_R+6),y:p.y+Math.sin(a)*(PLAYER_R+6),
      vx:Math.cos(a)*BULLET_SPEED,vy:Math.sin(a)*BULLET_SPEED,
      owner:socket.id,ownerTeam:p.team,ownerColor:p.color,life:BULLET_LIFE,
    });
  });

  socket.on('vote',({mapId})=>{
    if (!myRoom||myRoom.roundState!=='intermission') return;
    if (!myRoom.voteOptions.includes(mapId)) return;
    myRoom.votes[socket.id]=mapId;
    roomIO(myRoom).emit('voteUpdate',tallyVotes(myRoom).counts);
  });

  let lastChatTime=0;
  socket.on('chat',({msg,teamOnly})=>{
    if (!myRoom) return;
    const p=myRoom.players[socket.id];if (!p) return;
    const now=Date.now();if (now-lastChatTime<1000) return;
    lastChatTime=now;
    const clean=(msg||'').toString()
      .replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))
      .trim().slice(0,64);
    if (!clean) return;
    const payload={id:socket.id,name:p.name,color:p.color,msg:clean,teamOnly:!!teamOnly,team:p.team};
    if (teamOnly&&myRoom.mode==='tdm'&&p.team) {
      for (const [pid,tp] of Object.entries(myRoom.players)) if(tp.team===p.team) io.to(pid).emit('chat',payload);
    } else {
      roomIO(myRoom).emit('chat',payload);
    }
  });

  socket.on('disconnect',()=>{
    if (!myRoom) return;
    delete myRoom.players[socket.id];
    delete myRoom.roster[socket.id];
    delete myRoom.votes[socket.id];
    roomIO(myRoom).emit('playerLeft',socket.id);
    roomIO(myRoom).emit('rosterRemove',socket.id);
    schedulePlayerCount(myRoom);
    if (Object.keys(myRoom.players).length===0) delete rooms[myRoom.mode][myRoom.id];
  });
});

// ── Physics — 60/s ────────────────────────────────────────────────────────────
setInterval(()=>{
  const now=Date.now();
  for (const mode of ['ffa','tdm']) {
    for (const room of Object.values(rooms[mode])) {
      if (room.roundState!=='playing') continue;
      const pList=Object.values(room.players);
      if (pList.length===0) continue;
      const obs=currentObs(room);

      for (const p of pList) {
        if (!p.alive&&now>=p.respawnAt){const sp=randomSpawnForMap(room.currentMapId,p.team);p.x=sp.x;p.y=sp.y;p.hp=MAX_HP;p.alive=true;}
      }
      for (const p of pList) {
        if (!p.alive) continue;
        if (p.fireCooldown>0) p.fireCooldown--;
        const k=p.keys;let dx=0,dy=0;
        if(k.up)dy-=1;if(k.down)dy+=1;if(k.left)dx-=1;if(k.right)dx+=1;
        if(dx||dy){const len=Math.sqrt(dx*dx+dy*dy);[p.x,p.y]=moveWithSlide(p.x,p.y,dx/len*PLAYER_SPEED,dy/len*PLAYER_SPEED,PLAYER_R,obs);}
      }

      for (const b of room.bullets) {
        b.x+=b.vx;b.y+=b.vy;b.life--;
        if(b.life<=0||b.x<0||b.x>WORLD_W||b.y<0||b.y>WORLD_H){b.life=0;continue;}
        if(overlapsObstacle(b.x,b.y,BULLET_R,obs)){b.life=0;continue;}
        for (const p of pList) {
          if(!p.alive||p.id===b.owner)continue;
          if(room.mode==='tdm'&&p.team===b.ownerTeam)continue;
          const dx=p.x-b.x,dy=p.y-b.y;
          if(dx*dx+dy*dy<(PLAYER_R+BULLET_R)**2){
            b.life=0;p.hp-=DAMAGE;
            io.to(p.id).emit('damaged',{hp:Math.max(0,p.hp)});
            if(p.hp<=0){
              p.hp=0;p.alive=false;p.deaths++;p.respawnAt=now+RESPAWN_MS;
              const shooter=room.players[b.owner];
              if(shooter){
                shooter.kills++;shooter.score+=100;
                if(room.mode==='tdm'&&shooter.team){
                  room.teamKills[shooter.team]=(room.teamKills[shooter.team]||0)+1;
                  roomIO(room).emit('teamKills',room.teamKills);
                  if(room.teamKills[shooter.team]>=TDM_KILLS_TO_WIN){
                    room.leaderboardDirty=true;
                    roomIO(room).emit('kill',{killerName:shooter.name,killerColor:shooter.color,killerTeam:shooter.team,victimName:p.name,victimColor:p.color,victimTeam:p.team});
                    roomIO(room).emit('leaderboard',getLeaderboard(room));
                    roomIO(room).emit('died',{victimId:p.id,respawnIn:RESPAWN_MS});
                    startIntermission(room);room.bullets.length=0;break;
                  }
                }
                room.leaderboardDirty=true;
                roomIO(room).emit('kill',{killerName:shooter.name,killerColor:shooter.color,killerTeam:shooter.team,victimName:p.name,victimColor:p.color,victimTeam:p.team});
                roomIO(room).emit('leaderboard',getLeaderboard(room));
              }
              if(room.roundState==='playing')roomIO(room).emit('died',{victimId:p.id,respawnIn:RESPAWN_MS});
            }
            break;
          }
        }
      }
      for(let i=room.bullets.length-1;i>=0;i--)if(room.bullets[i].life<=0)room.bullets.splice(i,1);
    }
  }
},PHYSICS_MS);

// ── Round timer ───────────────────────────────────────────────────────────────
setInterval(()=>{
  const now=Date.now();
  for(const mode of['ffa','tdm'])for(const room of Object.values(rooms[mode])){
    if(room.roundState==='playing'&&now>=room.roundEndsAt)startIntermission(room);
    else if(room.roundState==='intermission'&&now>=room.intermissionEndsAt)startRound(room,tallyVotes(room).winner);
  }
},500);

// ── Broadcast — 20/s ─────────────────────────────────────────────────────────
setInterval(()=>{
  const now=Date.now();
  for(const mode of['ffa','tdm'])for(const room of Object.values(rooms[mode])){
    const pList=Object.values(room.players);if(pList.length===0)continue;
    const allBullets=room.roundState==='playing'
      ?room.bullets.map(b=>({id:b.id,x:b.x|0,y:b.y|0,vx:b.vx,vy:b.vy,c:b.ownerColor})):[];
    const timeLeftSec=room.roundState==='playing'
      ?Math.max(0,Math.ceil((room.roundEndsAt-now)/1000))
      :Math.max(0,Math.ceil((room.intermissionEndsAt-now)/1000));
    for(const[sid,sock]of io.sockets.sockets){
      const me=room.players[sid];if(!me)continue;
      const visPlayers=pList.filter(p=>inViewport(p.x,p.y,me.x,me.y)).map(p=>({
        id:p.id,x:p.x|0,y:p.y|0,angle:Math.round(p.angle*10)/10,
        hp:p.hp,alive:p.alive,team:p.team,
        ...(p.id===sid?{kills:p.kills,score:p.score}:{}),
      }));
      const visBullets=allBullets.filter(b=>inViewport(b.x,b.y,me.x,me.y));
      sock.emit('state',{
        players:visPlayers,bullets:visBullets,
        roundState:room.roundState,t:timeLeftSec,
        teamKills:room.mode==='tdm'?room.teamKills:undefined,
      });
    }
  }
},BROADCAST_MS);

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Arena.io — Weekly LB active — port ${PORT}`));
