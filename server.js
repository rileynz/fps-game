const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const compression = require('compression');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const Stripe = require('stripe');
const analytics = require('./analytics');
const announcements = require('./announcements');
const challengeSystem = require('./challenges');
const stormSystem = require('./storm');
const BOT_NAMES = require('./bot-names');
const calendar = require('./calendar');
const premiumShop = require('./premium-shop');
const purchaseReceipts = require('./purchase-receipts');
const secureAccounts = require('./secure-accounts');
const networkCodec = require('./network-codec');
const killStreaks = require('./kill-streaks');
const ricochet = require('./ricochet');
const {SocialSystem,ensureSocial,MAX_PARTY_SIZE} = require('./social-system');
const {createAdminMetrics} = require('./admin-metrics');
const packageMetadata = require('./package.json');

const STRIPE_SECRET_KEY=process.env.STRIPE_SECRET_KEY||'';
const STRIPE_WEBHOOK_SECRET=process.env.STRIPE_WEBHOOK_SECRET||'';
const PUBLIC_BASE_URL=String(process.env.PUBLIC_BASE_URL||'').replace(/\/+$/,'');
const RESEND_API_KEY=process.env.RESEND_API_KEY||'';
const EMAIL_FROM=process.env.EMAIL_FROM||'';
const PURCHASE_EMAIL_FROM=process.env.PURCHASE_EMAIL_FROM||'Arena.io Purchases <purchases@mail.rileybylsma.tech>';
const stripe=STRIPE_SECRET_KEY?new Stripe(STRIPE_SECRET_KEY):null;
const runtimeMetrics=createAdminMetrics({
  monthlyBandwidthGb:Number(process.env.RENDER_BANDWIDTH_LIMIT_GB)||5,
});

const app = express();
app.set('trust proxy',1);
const server = http.createServer(app);
const io = new Server(server, { cors:{origin:'*'}, pingTimeout:10000, pingInterval:5000 });
app.use(runtimeMetrics.httpMiddleware);
app.use(compression({threshold:1024}));
// Stripe signature verification requires the exact raw request bytes. Keep this
// route before express.json() or every live webhook will fail verification.
app.post('/api/shop/stripe-webhook',express.raw({type:'application/json',limit:'256kb'}),handleStripeWebhook);
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const name=path.basename(filePath);
    if (name==='index.html'||name==='admin.html'||name==='sw.js'||name==='manifest.json') {
      res.setHeader('Cache-Control','no-cache');
      return;
    }
    if (filePath.includes(`${path.sep}icons${path.sep}`)||name==='chart.umd.js') {
      res.setHeader('Cache-Control','public, max-age=31536000, immutable');
      return;
    }
    if (/\.(?:js|css|png|jpg|jpeg|webp|svg|ico|woff2?)$/i.test(name)) {
      res.setHeader('Cache-Control','public, max-age=604800');
    }
  },
}));

// Lightweight readiness endpoint for portal builds. It lets the CrazyGames
// loading screen distinguish a sleeping Render service from a browser/network
// error without exposing deployment configuration or account data.
app.get('/api/health', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cache-Control', 'no-store');
  res.json({ ok:true, service:'arena-io', now:Date.now() });
});

// ── Analytics dashboard ──────────────────────────────────────────────────────
// Protected by ADMIN_KEY env var. Set this in your host's environment vars —
// if it's not set, a random key is generated at boot and printed to the
// server log once, so the dashboard is never left open with a default key.
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(12).toString('hex');
if (!process.env.ADMIN_KEY) {
  console.log(`\n[analytics] No ADMIN_KEY set — generated one for this run:\n[analytics] ${ADMIN_KEY}\n[analytics] Set ADMIN_KEY in your environment to keep this stable across restarts.\n`);
}

function adminKeyMatches(value) {
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(ADMIN_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function requireAdmin(req, res, next) {
  if (!adminKeyMatches(req.get('x-admin-key'))) {
    return res.status(401).json({ ok: false, reason: 'bad_key' });
  }
  res.set('Cache-Control', 'no-store');
  next();
}

function currentOnlineCount() {
  let n = 0;
  for (const mode of ['ffa', 'ranked', 'tdm', 'lms']) {
    for (const room of Object.values(rooms[mode])) {
      n += realPlayerCount(room);
    }
  }
  return n;
}

function currentProtocolCounts() {
  const counts={binaryV4:0,binaryV3:0,compactV2:0,legacy:0};
  for(const socket of io.sockets.sockets.values()){
    if(socket.data.compactStateVersion===4)counts.binaryV4++;
    else if(socket.data.compactStateVersion===3)counts.binaryV3++;
    else if(socket.data.compactStateVersion===2)counts.compactV2++;
    else counts.legacy++;
  }
  return counts;
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/summary', requireAdmin, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 14));
    const summary = await analytics.getSummary({ days });
    summary.onlineNow = currentOnlineCount();
    summary.roomsOpen = { ffa: Object.keys(rooms.ffa).length, tdm: Object.keys(rooms.tdm).length, ranked: Object.keys(rooms.ranked).length, lms: Object.keys(rooms.lms).length };
    summary.liveRooms=getLiveRoomSummary();
    summary.accounts=getAccountAnalytics();
    summary.commerce=await getCommerceAnalytics(days,summary);
    summary.runtime=runtimeMetrics.summary({onlineNow:summary.onlineNow});
    summary.runtime.protocols=currentProtocolCounts();
    summary.health={
      database:!!db,
      stripe:!!stripe,
      resend:!!RESEND_API_KEY&&!!EMAIL_FROM,
      purchaseEmail:!!RESEND_API_KEY&&!!PURCHASE_EMAIL_FROM,
      version:packageMetadata.version,
      deploy:String(process.env.RENDER_GIT_COMMIT||'').slice(0,8)||'local',
    };
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error('admin summary err:', e.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// ── Announcements ────────────────────────────────────────────────────────────
app.get('/api/announcements', async (req, res) => {
  try {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');
    res.json({ ok: true, announcements: await announcements.listPublic() });
  } catch (e) {
    console.error('public announcements err:', e.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.get('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, announcements: await announcements.listAdmin() });
  } catch (e) {
    console.error('list announcements err:', e.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.post('/api/admin/announcements', requireAdmin, async (req, res) => {
  try {
    const result = await announcements.create(req.body);
    res.status(result.ok ? 201 : 400).json(result);
  } catch (e) {
    console.error('create announcement err:', e.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.patch('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const result = await announcements.update(req.params.id, req.body);
    const status = result.ok ? 200 : result.reason === 'not_found' ? 404 : 400;
    res.status(status).json(result);
  } catch (e) {
    console.error('update announcement err:', e.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.delete('/api/admin/announcements/:id', requireAdmin, async (req, res) => {
  try {
    const result = await announcements.remove(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  } catch (e) {
    console.error('delete announcement err:', e.message);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// ── MongoDB ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI;
let db = null;

async function connectDB() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db('arena');
  console.log('MongoDB connected');
  await db.collection('ranks').createIndex({ key: 1 }, { unique: true });
  await db.collection('ranks').createIndex(
    { secureEmail:1 },
    { unique:true,partialFilterExpression:{secureEmail:{$type:'string'}} }
  );
  await db.collection('daily_progress').createIndex({ key: 1 }, { unique: true });
  await db.collection('account_sessions').createIndex({ tokenHash:1 }, { unique:true });
  await db.collection('account_sessions').createIndex({ expiresAt:1 }, { expireAfterSeconds:0 });
  await db.collection('purchases').createIndex({ checkoutSessionId:1 }, { unique:true });
  await db.collection('purchases').createIndex({ paymentIntentId:1 }, { sparse:true });
  await db.collection('stripe_events').createIndex({ eventId:1 }, { unique:true });
  analytics.init(db);
  await announcements.init(db);
}

// ── In-memory caches ───────────────────────────────────────────────────────────
let rankData = {};
let weekly = { weekKey: '', entries: [], prevWeek: null };

// ── Constants ─────────────────────────────────────────────────────────────────
const WORLD_W = 2400, WORLD_H = 2400;
const PHYSICS_MS   = 1000 / 60;
const BROADCAST_MS = 1000 / 20;
// Protocol v2 and older clients use this conservative fallback. Protocol v3
// reports its real screen size and receives the visible area plus a generous
// prediction margin instead of almost the entire map.
const VIEWPORT_PAD = 1150;
const VIEWPORT_MARGIN = 320;
const BULLET_CORRECTION_DIVISOR = 4; // 20 Hz players, 5 Hz projectile correction
const PLAYER_R = 15, BULLET_R = 5;
const BULLET_MUZZLE_OFFSET = PLAYER_R + 16;
const BULLET_SPEED = 10, BULLET_LIFE = 180;
const PLAYER_SPEED = 4.0;
const RESPAWN_MS = 3000;
const DAMAGE = 25, MAX_HP = 100;
const KILL_HEAL = 25;
const FIRE_COOLDOWN = 10, MAX_BULLETS = 300;

// ── Weapons ───────────────────────────────────────────────────────────────────
// Players pick a loadout before spawning (menu, or from the death screen while
// waiting to respawn). Stats are tuned so each weapon's theoretical DPS lands
// in a similar band (~85-150), so the differences are about playstyle
// (range/burst/accuracy tradeoffs), not one weapon just being strictly better.
// fireCooldown is in physics ticks (60/s), same unit as the old FIRE_COOLDOWN.
const WEAPONS = {
  pistol:  { id:'pistol',  name:'Pistol',  emoji:'🔫', desc:'Balanced · one ricochet',      damage:25, fireCooldown:10, bulletSpeed:10,   bulletLife:180, pellets:1, spread:0,    bulletR:5 },
  shotgun: { id:'shotgun', name:'Shotgun', emoji:'💥', desc:'Close burst · one ricochet',   damage:14, fireCooldown:28, bulletSpeed:9,    bulletLife:70,  pellets:5, spread:0.32, bulletR:4 },
  smg:     { id:'smg',     name:'SMG',     emoji:'🔥', desc:'Fast spray · one ricochet',    damage:12, fireCooldown:5,  bulletSpeed:11,   bulletLife:150, pellets:1, spread:0.05, bulletR:4 },
  sniper:  { id:'sniper',  name:'Sniper',  emoji:'🎯', desc:'One shot · two ricochets',     damage:100, fireCooldown:96, bulletSpeed:16, bulletLife:260, pellets:1, spread:0, bulletR:5 },
};
const DEFAULT_WEAPON = 'pistol';
function isValidWeapon(w) { return typeof w === 'string' && !!WEAPONS[w]; }

// ── Last Man Standing ────────────────────────────────────────────────────────
// Deaths respawn normally (like FFA) for the first LMS_GRACE_MS of the round.
// After that, deaths are final and the player becomes a spectator. A circular
// safe zone shrinks in distinct phases (hold → shrink → hold → shrink...),
// each phase telegraphed to players ahead of time, damaging anyone caught
// outside it once per second — forces the match toward a conclusion instead
// of letting players stall in a corner.
const LMS_GRACE_MS = 45 * 1000; // must land exactly on a phase boundary below
const LMS_ZONE_MIN_RADIUS = 200;
const LMS_ZONE_DPS = 6; // flat damage applied once per second while outside the zone
// Each phase: how long it lasts, whether it holds steady or shrinks, and what
// fraction of the starting radius it shrinks to (null = shrink to LMS_ZONE_MIN_RADIUS).
// Timeline: hold(15s) -> shrink to 62%(30s, ends at 45s = grace end) -> hold(10s)
// -> shrink to 36%(25s) -> hold(10s) -> shrink to final(20s) -> hold until round ends.
const LMS_ZONE_TIMELINE = [
  { durationMs:15000, type:'hold',   toFrac:1.00 },
  { durationMs:30000, type:'shrink', toFrac:0.62 },
  { durationMs:10000, type:'hold',   toFrac:0.62 },
  { durationMs:25000, type:'shrink', toFrac:0.36 },
  { durationMs:10000, type:'hold',   toFrac:0.36 },
  { durationMs:20000, type:'shrink', toFrac:null  },
];

const LEADERBOARD_SIZE = 10;
const WEEKLY_LB_SIZE = 10;
const ROUND_DURATION_MS = 3 * 60 * 1000;
const INTERMISSION_MS   = 15 * 1000;
const VOTE_MAP_COUNT = 3;
const TDM_KILLS_TO_WIN = 20;
const FFA_MAX = 20;
const TDM_MAX = 16;
const RANKED_MAX = 20;
const LMS_MAX = 20;
// TDM is intentionally not in the public playlist. Keep its implementation for
// historical analytics/data compatibility, but do not restore it to matchmaking
// during ordinary bug fixes. See GAME_NOTES.md.
const PUBLIC_GAME_MODES = new Set(['ffa', 'ranked', 'lms']);
const TEAM_RED_COLOR  = '#e74c3c';
const TEAM_BLUE_COLOR = '#3498db';
const FFA_COLORS = [
  '#e74c3c','#2ecc71','#f39c12','#9b59b6',
  '#1abc9c','#e67e22','#e91e8c','#00bcd4','#8bc34a','#ff6b6b',
];

// ── Bot constants ─────────────────────────────────────────────────────────────
const BOT_TARGET_TOTAL  = 6;
const BOT_MAX_REAL      = 4;
const BOT_CHASE_RANGE   = 520;
const BOT_SHOOT_RANGE   = 360;
const BOT_TARGET_LOCK_MS = 2800;
const BOT_STUCK_TICKS   = 90;
const BOT_WANDER_CHANGE = 180;
const BOT_AWARE_FOV     = Math.PI * 1.1;
const BOT_CHAT_MIN_MS   = 30000;
const BOT_CHAT_MAX_MS   = 120000;
// Contextual chat — arrays keyed by event type
const BOT_CHAT = {
  random: [
    // gen z / internet brain
    'skibidi','67','fr fr','no cap','bussin','ngl','slay','rizz','sigma','based',
    'lowkey','highkey','understood the assignment','rent free','its giving','main character',
    'hit different','understood','periodt','sheesh','W','L','mid','cooked','dead 💀',
    'not me','real','cope','seethe','ratio','gg ez','touch grass','down bad',
    'literally crying','the audacity','ok boomer','bet','fax no printer',
    'on god','slaps','goated','sus','caught in 4k','its joever','we so back',
    'hold on','wait what','nah bro','bro what','actually insane','core memory',
    'not gonna lie','certified','valid','hits hard','era','understood the vibe',
    // random numbers / chaotic
    '67','68','99','42','7','100','0','404','69','1','365','13',
    // just vibes
    '💀','🔥','👀','😭','🗿','🤡','🏆','👑','💅','🫡','🫠','😤','🤯','💯',
    '...','hmm','ok','wait','no','yes','maybe','idk','sure','k','lol','lmao',
    'bruh','bro','dude','man','yo','ayo','nah','yep','yup','nope',
    // game related chaos
    'this map','why','how','who made this','not fair','actually','literally',
    'for real','no way','what','huh','oh','ah','oh no','gg','ggs',
    'rip','F','moment','clip it','highlight reel','speedrun','any%',
    'this is fine','everything is fine','its fine','totally fine',
  ],
  killed: [
    // confident
    'ez','too slow','not even close','lol','clean','bye','💀','see ya',
    'next','rip','not today','stay down','skill issue','touch grass',
    'get cooked','cooked','ratio','W','gg no re','delete the game',
    'uninstall','practice more','its giving skill issue','cope',
    // chaotic
    '67','boom','🔥','sheesh','slay','sigma move','based','goated',
    'ngl felt good','understood the assignment','W rizz','main character moment',
    'not my fault','natural talent','born different','gifted','genes',
    // funny
    'sorry not sorry','my bad lol jk','oops','whoops','did i do that',
    'accident fr','didnt mean it','meant to do that','perfectly balanced',
    'as all things should be','thanos mode','inevitable',
  ],
  died: [
    // cope
    'lag','lagging rn','my wifi','ping issue','server diff','hit reg',
    'that didnt hit','bro that missed','bs','no way that hit','rigged',
    'scripted','literally impossible','hacker','cheater','reported',
    // self aware
    'skill issue (me)','i cooked myself','L','down bad','cooked',
    'ratio myself','i fumbled','peak fumble','my fault','my bad',
    'cant believe i','unbelievable','actually cannot','i need to cope',
    // just saying stuff
    '??','???','what','HOW','no','noooo','come ON','ugh','bro',
    'next round','we go again','rematch','run it back','this isnt over',
    'i was going easy','wasnt trying','holding back','full power next time',
    'ok ok ok','right right right','noted','ill remember that',
  ],
  topRound:[
    'gg all','easy game','🏆','run it back','👑','W game',
    'that was fun ngl','average round for me','just woke up tbh',
    'still half asleep','not even trying','imagine trying hard',
    'carried','diff','sigma grindset','rise and grind','natural',
    'goated with the sauce','cooked everyone','W rizz energy',
    'everyone played well (except the others)','peak performance',
    'this is my map','home turf','comfortable','in my element',
  ],
  lowHp:[
    'omg','LOW','pls no','running','😭','clutch time','not like this',
    'i have a family','i cant go out like this','so close to greatness',
    'the disrespect','this is fine 🔥','everything is fine',
    'health diff','need heals','anyone have a bandage','bro',
    'this is my villain arc','gotta go fast','speedrunning death',
    'not today','survival mode activated','cockroach mode','built different',
  ],
};
// ── Rank system ───────────────────────────────────────────────────────────────
const RANK_TIERS = [
  { name:'Bronze',   min:0,    max:1199, color:'#cd7f32', emoji:'🔘', glow:'rgba(205,127,50,0.6)'   },
  { name:'Silver',   min:1200, max:2199, color:'#aaaaaa', emoji:'⚪', glow:'rgba(170,170,170,0.5)'  },
  { name:'Gold',     min:2200, max:3499, color:'#f39c12', emoji:'🟡', glow:'rgba(243,156,18,0.6)'   },
  { name:'Platinum', min:3500, max:4999, color:'#1abc9c', emoji:'💎', glow:'rgba(26,188,156,0.6)'   },
  { name:'Diamond',  min:5000, max:6999, color:'#3498db', emoji:'💠', glow:'rgba(52,152,219,0.6)'   },
  { name:'Master',   min:7000, max:9999, color:'#9b59b6', emoji:'💜', glow:'rgba(155,89,182,0.6)'   },
  { name:'Champion', min:10000, max:Infinity, color:'#e74c3c', emoji:'👑', glow:'rgba(231,76,60,0.7)' },
];
const STARTING_SR = 1000;

function getTier(sr) {
  for (let i = RANK_TIERS.length - 1; i >= 0; i--) {
    if (sr >= RANK_TIERS[i].min) return { ...RANK_TIERS[i], index: i };
  }
  return { ...RANK_TIERS[0], index: 0 };
}

function srProgressInTier(sr) {
  const tier = getTier(sr);
  if (tier.max === Infinity) return Math.min(1, (sr - tier.min) / 5000);
  const span = tier.max - tier.min + 1;
  return Math.max(0, Math.min(1, (sr - tier.min) / span));
}

// ── DB: load all ranks into memory on startup ─────────────────────────────────
async function loadRanksFromDB() {
  const docs = await db.collection('ranks').find({}).toArray();
  const migratedNames=[];
  rankData = {};
  for (const doc of docs) {
    const name=cleanPlayerName(doc&&doc.name)||cleanPlayerName(doc&&doc.key);
    const key=playerNameKey(name);
    if (!key) continue;
    const sr=Number(doc.sr);
    rankData[key] = {
      ...doc,
      name,
      sr:Number.isFinite(sr)&&sr>=0?Math.round(sr):STARTING_SR,
      accountId:typeof doc.accountId==='string'&&doc.accountId?doc.accountId:crypto.randomUUID(),
    };
    if (!(typeof doc.accountId==='string'&&doc.accountId)) migratedNames.push(name);
    delete rankData[key]._id;
    delete rankData[key].key;
  }
  for (const name of migratedNames) await savePlayerRank(name);
  console.log(`Loaded ${docs.length} player rank records from MongoDB`);
}

// ── DB: save one player's rank record ────────────────────────────────────────
async function savePlayerRank(name) {
  if (!db) return;
  const key = playerNameKey(name);
  if (!key) return;
  const rec = rankData[key];
  if (!rec) return;
  try {
    await db.collection('ranks').updateOne(
      { key },
      { $set: { key, ...rec } },
      { upsert: true }
    );
  } catch(e) { console.error('savePlayerRank error:', e.message); }
}

// Kept synchronous-compatible wrapper for code that calls saveRanks() broadly
function saveRanks() {
  // Fire-and-forget: save all dirty records
  for (const key of Object.keys(rankData)) {
    savePlayerRank(rankData[key].name || key).catch(e => console.error('saveRanks err:', e.message));
  }
}

function getPlayerRank(name) {
  const cleanName=cleanPlayerName(name);
  const key=playerNameKey(cleanName);
  if (!key) return { sr:STARTING_SR, name:'Player' };
  if (!rankData[key]) rankData[key] = { sr: STARTING_SR, name: cleanName };
  if (!Number.isFinite(rankData[key].sr)||rankData[key].sr<0)rankData[key].sr=STARTING_SR;
  if (!cleanPlayerName(rankData[key].name))rankData[key].name=cleanName;
  if (!rankData[key].accountId)rankData[key].accountId=crypto.randomUUID();
  return rankData[key];
}

// ── Friends, presence, and parties ───────────────────────────────────────────
// Friend relationships live on the existing account record, so deployments do
// not need another database or migration. Parties are intentionally ephemeral:
// they are coordination state, not player data, and disappear when empty.
const accountSockets=new Map();
const partyInviteGrants=new Map();
const socialSystem=new SocialSystem({
  getAccount:key=>rankData[key]||null,
  saveAccount:async key=>{
    const rank=rankData[key];
    if(rank)await savePlayerRank(rank.name);
  },
});

function socialMemberId(socket,key=null){
  return key?`account:${key}`:`guest:${socket.id}`;
}

function registerAccountSocket(socket,key){
  const previous=socket.data.socialAccountKey;
  if(previous===key)return;
  if(previous)unregisterAccountSocket(socket);
  if(!key)return;
  const sockets=accountSockets.get(key)||new Set();
  sockets.add(socket.id);
  accountSockets.set(key,sockets);
  socket.data.socialAccountKey=key;
}

function unregisterAccountSocket(socket){
  const key=socket.data.socialAccountKey;
  if(!key)return;
  const sockets=accountSockets.get(key);
  if(sockets){
    sockets.delete(socket.id);
    if(!sockets.size)accountSockets.delete(key);
  }
  socket.data.socialAccountKey=null;
}

function accountSocketList(key){
  const ids=accountSockets.get(key)||new Set();
  return [...ids].map(id=>io.sockets.sockets.get(id)).filter(Boolean);
}

function partyPublicPayload(party,viewerMemberId){
  if(!party)return null;
  return {
    code:party.code,
    open:party.open,
    mode:party.mode,
    maxSize:MAX_PARTY_SIZE,
    isLeader:party.leaderId===viewerMemberId,
    members:party.members.map(member=>({
      id:member.socketId,
      name:member.name,
      platform:member.platform,
      self:member.id===viewerMemberId,
      leader:member.id===party.leaderId,
    })),
  };
}

function emitParty(party){
  if(!party)return;
  for(const member of party.members){
    const target=io.sockets.sockets.get(member.socketId);
    if(target)target.emit('partyState',partyPublicPayload(party,member.id));
  }
}

function emitPartyCleared(socket,reason='left'){
  socket.emit('partyState',{party:null,reason});
}

function presenceForAccount(key){
  const rank=rankData[key];
  const social=rank&&ensureSocial(rank);
  if(!rank||!social||social.appearOffline)return{status:'offline',joinable:false};
  const sockets=accountSocketList(key);
  if(!sockets.length)return{status:'offline',joinable:false};
  const playing=sockets.find(item=>item.data.gameMode);
  const active=playing||sockets[0];
  const party=socialSystem.getPartyByMember(socialMemberId(active,key));
  const joinable=!!(party&&party.open&&party.members.length<MAX_PARTY_SIZE&&social.joinPolicy==='friends');
  return {
    status:playing?'playing':'online',
    mode:playing?.data.gameMode||null,
    joinable,
    partyCode:joinable?party.code:null,
  };
}

function socialName(key){
  return cleanPlayerName(rankData[key]?.name)||'Player';
}

function socialSnapshot(key){
  const rank=rankData[key];
  const social=rank&&ensureSocial(rank);
  if(!social)return{signedIn:false};
  const friendRows=social.friends
    .map(friendKey=>{
      if(!rankData[friendKey])return null;
      return{name:socialName(friendKey),...presenceForAccount(friendKey)};
    })
    .filter(Boolean)
    .sort((a,b)=>{
      const order={playing:0,online:1,offline:2};
      return(order[a.status]??3)-(order[b.status]??3)||a.name.localeCompare(b.name);
    });
  return {
    signedIn:true,
    friends:friendRows,
    incoming:social.incoming.filter(item=>rankData[item]).map(nameKey=>({name:socialName(nameKey)})),
    outgoing:social.outgoing.filter(item=>rankData[item]).map(nameKey=>({name:socialName(nameKey)})),
    blocked:social.blocked.filter(item=>rankData[item]).map(nameKey=>({name:socialName(nameKey)})),
    settings:{joinPolicy:social.joinPolicy,appearOffline:social.appearOffline},
  };
}

function recentPlayersSnapshot(key){
  const rank=rankData[key];
  const social=rank&&ensureSocial(rank);
  if(!social)return{signedIn:false,players:[]};
  const friends=new Set(social.friends);
  const blocked=new Set(social.blocked);
  const players=social.recentPlayers
    .filter(item=>rankData[item.key]&&!friends.has(item.key)&&!blocked.has(item.key))
    .map(item=>({
      name:socialName(item.key),
      mode:item.mode,
      playedAt:item.playedAt,
      matches:item.matches,
      relation:social.incoming.includes(item.key)
        ?'incoming'
        :social.outgoing.includes(item.key)?'outgoing':'none',
    }));
  return{signedIn:true,owner:socialName(key),players};
}

function emitSocialState(key){
  if(!key)return;
  const snapshot=socialSnapshot(key);
  for(const socket of accountSocketList(key))socket.emit('socialState',snapshot);
}

function emitSocialStateAndFriends(key){
  if(!key)return;
  const social=rankData[key]&&ensureSocial(rankData[key]);
  emitSocialState(key);
  for(const friendKey of social?.friends||[])emitSocialState(friendKey);
}

function findPartyRoom(party,mode){
  const existing=party&&party.gameRoomId&&rooms[mode]?.[party.gameRoomId];
  if(existing){
    const max=mode==='ranked'?RANKED_MAX:mode==='lms'?LMS_MAX:FFA_MAX;
    if(Object.keys(existing.players).length<max)return existing;
  }
  const room=createRoom(mode);
  if(party){
    party.mode=mode;
    party.gameRoomId=room.id;
  }
  return room;
}

// ── Shards & Cosmetics ───────────────────────────────────────────────────────
// Shards are the persistent currency earned from daily challenges, spent on
// cosmetics. Everything lives on the same rank record as SR/PIN data, so it
// rides along with the existing save/load path for free.
const COSMETICS = {
  nameColor: [
    { id:'nc_default',  name:'Default',      cost:0,    value:null },
    { id:'nc_white',     name:'Snow White',   cost:100,  value:'#ffffff' },
    { id:'nc_red',       name:'Crimson',      cost:100,  value:'#ff5252' },
    { id:'nc_blue',      name:'Glacier',      cost:100,  value:'#54a0ff' },
    { id:'nc_orange',    name:'Tangerine',    cost:120,  value:'#ff9248' },
    { id:'nc_green',     name:'Toxic',        cost:150,  value:'#2ecc71' },
    { id:'nc_purple',    name:'Amethyst',     cost:150,  value:'#9b59b6' },
    { id:'nc_teal',      name:'Seafoam',      cost:150,  value:'#1abc9c' },
    { id:'nc_yellow',    name:'Lemon',        cost:175,  value:'#f1c40f' },
    { id:'nc_gold',      name:'Gold',         cost:250,  value:'#f39c12' },
    { id:'nc_cyan',      name:'Frostbyte',    cost:250,  value:'#00e5ff' },
    { id:'nc_lime',      name:'Slime',        cost:250,  value:'#aef359' },
    { id:'nc_indigo',    name:'Nightshade',   cost:275,  value:'#6c5ce7' },
    { id:'nc_pink',      name:'Bubblegum',    cost:300,  value:'#ff6bcb' },
    { id:'nc_silver',    name:'Platinum',     cost:325,  value:'#dfe6e9' },
    { id:'nc_maroon',    name:'Garnet',       cost:325,  value:'#c0392b' },
    { id:'nc_rainbow',   name:'Prism',        cost:400,  value:'rainbow' },
    { id:'nc_fire',      name:'Inferno',      cost:400,  value:'fire' },
    { id:'nc_void',      name:'Void Pulse',   cost:550,  value:'void' },
    { id:'nc_neon',      name:'Neon Cycle',   cost:550,  value:'neon' },
    { id:'nc_holo',      name:'Holo Shift',   cost:700,  value:'holo' },
    { id:'nc_supporter_pulse',name:'Supporter Pulse',cost:null,value:'neon',premiumOnly:true },
    { id:'nc_elite_prism',name:'Elite Prism',cost:null,value:'holo',premiumOnly:true },
  ],
  trail: [
    { id:'tr_none',      name:'None',         cost:0,    style:null },
    { id:'tr_dust',      name:'Dust',         cost:150,  style:'dust',     color:'#d8c7a5',palette:['#8d7960','#ead9b7'] },
    { id:'tr_embers',    name:'Embers',       cost:200,  style:'embers',   color:'#ff6b35',palette:['#ff3d00','#ffb300','#fff3b0'] },
    { id:'tr_frost',     name:'Frost',        cost:200,  style:'frost',    color:'#72e6ff',palette:['#2dd4ff','#a8f3ff','#ffffff'] },
    { id:'tr_toxic',     name:'Toxic Ooze',   cost:250,  style:'toxic',    color:'#76ff03',palette:['#39ff14','#d7ff00','#00e676'] },
    { id:'tr_bubbles',   name:'Bubbles',      cost:250,  style:'bubbles',  color:'#54a0ff',palette:['#54a0ff','#00e5ff','#ff7ee2'] },
    { id:'tr_petals',    name:'Petals',       cost:275,  style:'petals',   color:'#ff8fab',palette:['#ff5ca8','#ffc2d4','#fff0f5'] },
    { id:'tr_shadow',    name:'Shadow',       cost:300,  style:'shadow',   color:'#7c4dff',palette:['#160b2f','#6c2bd9','#b388ff'] },
    { id:'tr_ash',       name:'Ash',          cost:300,  style:'ash',      color:'#aab2bd',palette:['#4b5563','#9ca3af','#e5e7eb'] },
    { id:'tr_sparkle',   name:'Sparkle',      cost:350,  style:'sparkle',  color:'#ffd700',palette:['#ffb300','#ffe066','#ffffff'] },
    { id:'tr_static',    name:'Static',       cost:350,  style:'static',   color:'#00e5ff',palette:['#00e5ff','#4d7cff','#ffffff'] },
    { id:'tr_blood',     name:'Crimson Rush', cost:400,  style:'crimson',  color:'#ff1744',palette:['#8b0015','#ff1744','#ff8a80'] },
    { id:'tr_galaxy',    name:'Galaxy',       cost:450,  style:'galaxy',   color:'#9b59b6',palette:['#4d2cff','#b12cff','#00d9ff','#ff66c4'] },
    { id:'tr_comet',     name:'Comet',        cost:500,  style:'comet',    color:'#00e5ff',palette:['#0066ff','#00e5ff','#ffffff'] },
    { id:'tr_rainbow',   name:'Rainbow Dash', cost:500,  style:'rainbow',  color:'#ff4d8d',palette:['#ff3b30','#ffcc00','#34c759','#00c7ff','#af52de'] },
    { id:'tr_void',      name:'Void Trail',   cost:650,  style:'void',     color:'#8b5cf6',palette:['#10002b','#5a189a','#c77dff','#00e5ff'] },
    { id:'tr_supporter_plasma',name:'Plasma Trail',cost:null,style:'plasma',color:'#00e5ff',palette:['#00e5ff','#7c4dff','#ff2bd6','#ffffff'],premiumOnly:true },
    { id:'tr_elite_nova',name:'Nova Trail',cost:null,style:'nova',color:'#ffd166',palette:['#ff3b30','#ffcc00','#00e5ff','#9b5de5','#ffffff'],premiumOnly:true },
  ],
  killFx: [
    { id:'kf_default',   name:'Default',      cost:0,    style:null },
    { id:'kf_glow',       name:'Glow',         cost:200,  style:'glow',  color:'#ffffff' },
    { id:'kf_fire',       name:'Flame Border', cost:300,  style:'fire',  color:'#ff7043' },
    { id:'kf_ice',        name:'Frozen',       cost:300,  style:'ice',   color:'#80deea' },
    { id:'kf_toxic',      name:'Venom Tag',    cost:350,  style:'glow',  color:'#76ff03' },
    { id:'kf_void',       name:'Void Tag',     cost:400,  style:'ice',   color:'#6c5ce7' },
    { id:'kf_skull',      name:'Skull Tag',    cost:450,  style:'skull', color:'#ffffff' },
    { id:'kf_electric',   name:'Electric Tag', cost:500,  style:'electric', color:'#00e5ff' },
    { id:'kf_gold',       name:'Gold Banner',  cost:500,  style:'gold',  color:'#f39c12' },
    { id:'kf_royal',      name:'Royal Banner', cost:550,  style:'gold',  color:'#9b59b6' },
    { id:'kf_rainbow',    name:'Prismatic',    cost:600,  style:'rainbow', color:null },
    { id:'kf_legendary',  name:'Legendary Tag',cost:800,  style:'legendary', color:'#f39c12' },
    { id:'kf_supporter_shockwave',name:'Shockwave Tag',cost:null,style:'electric',color:'#00e5ff',premiumOnly:true },
    { id:'kf_elite_arena',name:'Arena Burst',cost:null,style:'legendary',color:'#f39c12',premiumOnly:true },
  ],
};

function getCosmeticDef(category, id) {
  if (!id) return null;
  const list = COSMETICS[category];
  return list ? list.find(c => c.id === id) || null : null;
}

function ensureCosmeticState(rank) {
  rank.shards = Number.isFinite(Number(rank.shards))
    ? Math.max(0, Math.floor(Number(rank.shards)))
    : 0;
  if (!rank.ownedCosmetics || typeof rank.ownedCosmetics !== 'object') {
    rank.ownedCosmetics = {};
  }
  if (!rank.equipped || typeof rank.equipped !== 'object') rank.equipped = {};
  const defaults = { nameColor:'nc_default', trail:'tr_none', killFx:'kf_default' };
  for (const [category, defaultId] of Object.entries(defaults)) {
    const validIds = new Set(COSMETICS[category].map(item => item.id));
    const existing = Array.isArray(rank.ownedCosmetics[category])
      ? rank.ownedCosmetics[category].filter(id => typeof id === 'string' && validIds.has(id))
      : [];
    if (!existing.includes(defaultId)) existing.unshift(defaultId);
    rank.ownedCosmetics[category] = [...new Set(existing)];
    const equipped = rank.equipped[category];
    rank.equipped[category] = validIds.has(equipped) && rank.ownedCosmetics[category].includes(equipped)
      ? equipped
      : defaultId;
  }
  if (rank.streak === undefined) rank.streak = 0;
  if (rank.lastStreakDay === undefined) rank.lastStreakDay = null;
  premiumShop.ensurePremiumState(rank);
}

function awardShards(name, amount) {
  if (!amount || amount <= 0) return;
  const rank = getPlayerRank(name);
  ensureCosmeticState(rank);
  premiumShop.applyShardAward(rank,amount);
  savePlayerRank(name).catch(e => console.error('awardShards save err:', e.message));
}

// Returns the shop payload: catalog + this player's balance/owned/equipped state
function getShopPayload(name, session=null) {
  const rank = getPlayerRank(name);
  ensureCosmeticState(rank);
  const commerceReady=commerceSetupMissing().length===0;
  return {
    playerName:rank.name,
    shards: rank.shards,
    catalog: COSMETICS,
    owned: rank.ownedCosmetics,
    equipped: rank.equipped,
    streak: rank.streak,
    shardDebt:rank.shardDebt,
    premiumProducts:premiumShop.publicProducts().map(product=>({
      ...product,
      available:commerceReady&&product.configured,
    })),
    premiumOwned:Object.fromEntries(
      Object.entries(rank.premiumEntitlements)
        .map(([key,value])=>[key,value&&value.status==='active'])
    ),
    account:publicAccountSummary(rank,session),
  };
}

function buyCosmetic(name, category, id) {
  if (!COSMETICS[category]) return { ok:false, reason:'bad_category' };
  const def = getCosmeticDef(category, id);
  if (!def) return { ok:false, reason:'not_found' };
  if (def.premiumOnly) return {ok:false,reason:'premium_only'};
  const rank = getPlayerRank(name);
  ensureCosmeticState(rank);
  if (rank.ownedCosmetics[category].includes(id)) return { ok:false, reason:'already_owned' };
  if (rank.shards < def.cost) return { ok:false, reason:'insufficient_shards' };
  rank.shards -= def.cost;
  rank.ownedCosmetics[category].push(id);
  savePlayerRank(name).catch(e => console.error('buyCosmetic save err:', e.message));
  analytics.logEvent('purchase',{name,category,id,cost:def.cost});
  return { ok:true, shop:getShopPayload(name) };
}

function equipCosmetic(name, category, id) {
  if (!COSMETICS[category]) return { ok:false, reason:'bad_category' };
  const def = getCosmeticDef(category, id);
  if (!def) return { ok:false, reason:'not_found' };
  const rank = getPlayerRank(name);
  ensureCosmeticState(rank);
  if (!rank.ownedCosmetics[category].includes(id)) return { ok:false, reason:'not_owned' };
  rank.equipped[category] = id;
  savePlayerRank(name).catch(e => console.error('equipCosmetic save err:', e.message));
  return { ok:true, shop:getShopPayload(name) };
}

// Returns the small public-facing slice of cosmetics other players need to
// render this player correctly (their resolved nameColor/trail/killFx values,
// not the whole catalog).
function getPublicCosmetics(name) {
  const rank = getPlayerRank(name);
  ensureCosmeticState(rank);
  const nc = getCosmeticDef('nameColor', rank.equipped.nameColor);
  const tr = getCosmeticDef('trail', rank.equipped.trail);
  const kf = getCosmeticDef('killFx', rank.equipped.killFx);
  return {
    nameColor: nc ? nc.value : null,
    trail: tr ? {
      id:tr.id,
      style:tr.style,
      color:tr.color,
      palette:Array.isArray(tr.palette)?tr.palette.slice(0,6):null,
    } : null,
    killFx: kf ? { style:kf.style, color:kf.color } : null,
  };
}

// Streak: called once per day (on daily rollover) for every player who fully
// completed the previous day's challenges+bonus. Awards milestone shards at
// 3 / 7 / 14, then +500 every additional 7 days.
const STREAK_MILESTONES = [ {days:3,bonus:100}, {days:7,bonus:300}, {days:14,bonus:500} ];
function streakMilestoneBonus(streakDays) {
  for (const m of STREAK_MILESTONES) if (streakDays === m.days) return m.bonus;
  if (streakDays > 14 && (streakDays - 14) % 7 === 0) return 500;
  return 0;
}

// ── PIN account security ──────────────────────────────────────────────────────
const PIN_MIN_LEN = 4, PIN_MAX_LEN = 8;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 60 * 1000;
const ATTEMPT_MIN_GAP_MS = 350;

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function timingSafeEqualHex(a, b) {
  const bufA = Buffer.from(a, 'hex'), bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const CLIENT_PLATFORMS=new Set(['web','pwa','microsoft_store','crazygames','itch']);
function cleanClientPlatform(value) {
  return CLIENT_PLATFORMS.has(value)?value:'web';
}
function cleanViewport(value) {
  const viewport=asObject(value);
  const width=clamp(Math.round(Number(viewport.w)||1280),320,2560);
  const height=clamp(Math.round(Number(viewport.h)||720),320,1600);
  return {width,height};
}
function cleanPlayerName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f<>&"]/g, '')
    .trim()
    .slice(0, 16);
}
function playerNameKey(value) {
  return cleanPlayerName(value).toLowerCase();
}
function isValidPin(pin) {
  return typeof pin === 'string' && /^[0-9]{4,8}$/.test(pin);
}
function isValidName(name) {
  return !!cleanPlayerName(name);
}

function getAccountState(name) {
  const key = playerNameKey(name);
  if (!key) return { state:'none' };
  const rec = rankData[key];
  if (!rec) return {state:'none'};
  if (rec.secureEmail&&rec.passwordHash&&rec.emailVerifiedAt) {
    if (rec.secureLockedUntil&&Date.now()<rec.secureLockedUntil) {
      return {state:'secure_locked',retryAt:rec.secureLockedUntil};
    }
    return {state:'secured'};
  }
  if (!rec.pinHash) return { state: 'none' };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return { state: 'locked', retryAt: rec.lockedUntil };
  }
  return { state: 'protected', upgradePending:!!rec.pendingSecureEmail };
}

function createAccount(name, pin) {
  const cleanName = cleanPlayerName(name);
  const key = playerNameKey(cleanName);
  const rank = getPlayerRank(cleanName);
  const salt = makeSalt();
  rank.pinHash = hashPin(pin, salt);
  rank.pinSalt = salt;
  rank.failedAttempts = 0;
  rank.lockedUntil = 0;
  rank.name = cleanName;
  rankData[key] = rank;
  savePlayerRank(cleanName).catch(e => console.error('createAccount save err:', e.message));
}

function verifyPin(name, pin) {
  const cleanName = cleanPlayerName(name);
  const key = playerNameKey(cleanName);
  const rec = rankData[key];
  if (!rec || !rec.pinHash) return { ok: false, reason: 'no_account' };
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    return { ok: false, reason: 'locked', retryAt: rec.lockedUntil };
  }
  const candidate = hashPin(pin, rec.pinSalt);
  const correct = timingSafeEqualHex(candidate, rec.pinHash);
  if (correct) {
    rec.failedAttempts = 0;
    rec.lockedUntil = 0;
    savePlayerRank(cleanName).catch(e => console.error('verifyPin save err:', e.message));
    return { ok: true };
  }
  rec.failedAttempts = (rec.failedAttempts || 0) + 1;
  if (rec.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.failedAttempts = 0;
    savePlayerRank(cleanName).catch(e => console.error('verifyPin lock save err:', e.message));
    return { ok: false, reason: 'locked', retryAt: rec.lockedUntil };
  }
  savePlayerRank(cleanName).catch(e => console.error('verifyPin fail save err:', e.message));
  return { ok: false, reason: 'wrong_pin', attemptsLeft: MAX_FAILED_ATTEMPTS - rec.failedAttempts };
}

// ── Secure accounts & premium commerce ───────────────────────────────────────
const SESSION_COOKIE='arena_session';
const SESSION_MAX_AGE_MS=30*24*60*60*1000;
const SESSION_SHORT_AGE_MS=12*60*60*1000;
const EMAIL_CODE_MAX_AGE_MS=15*60*1000;
const PASSWORD_LOCKOUT_MS=15*60*1000;
const memorySessions=new Map();
const socketLoginCodes=new Map();
const stripeEventsInFlight=new Set();

function findRankByAccountId(accountId) {
  return Object.values(rankData).find(rank=>rank&&rank.accountId===accountId)||null;
}

function findRankBySecureEmail(email) {
  const normalized=secureAccounts.normalizeEmail(email);
  return normalized
    ?Object.values(rankData).find(rank=>rank&&rank.secureEmail===normalized)||null
    :null;
}

async function persistRankRecord(rank) {
  const key=playerNameKey(rank&&rank.name);
  if (!key) throw new Error('invalid_rank_record');
  rankData[key]=rank;
  if (!db) return;
  await db.collection('ranks').updateOne({key},{$set:{key,...rank}},{upsert:true});
}

function secureCookieOptions(req,persistent=true) {
  return {
    secure:!!(req.secure||PUBLIC_BASE_URL.startsWith('https://')),
    persistent,
    maxAgeSeconds:Math.floor((persistent?SESSION_MAX_AGE_MS:SESSION_SHORT_AGE_MS)/1000),
  };
}

function setSessionCookie(res,req,token,persistent=true) {
  res.setHeader('Set-Cookie',secureAccounts.sessionCookie(token,secureCookieOptions(req,persistent)));
}

async function createAccountSession(rank,{level='secure',persistent=true}={}) {
  const token=secureAccounts.randomToken();
  const tokenHash=secureAccounts.hashToken(token);
  const expiresAt=new Date(Date.now()+(persistent?SESSION_MAX_AGE_MS:SESSION_SHORT_AGE_MS));
  const record={
    tokenHash,
    accountId:rank.accountId,
    nameKey:playerNameKey(rank.name),
    level,
    createdAt:new Date(),
    expiresAt,
  };
  if (db) await db.collection('account_sessions').insertOne(record);
  else memorySessions.set(tokenHash,record);
  return {token,record};
}

async function accountSessionFromToken(token) {
  const tokenHash=secureAccounts.hashToken(token);
  const record=db
    ?await db.collection('account_sessions').findOne({tokenHash,expiresAt:{$gt:new Date()}})
    :memorySessions.get(tokenHash);
  if (!record||new Date(record.expiresAt).getTime()<=Date.now()) {
    memorySessions.delete(tokenHash);
    return null;
  }
  const rank=findRankByAccountId(record.accountId);
  if (!rank||playerNameKey(rank.name)!==record.nameKey) return null;
  if (record.level==='secure'&&(!rank.secureEmail||!rank.emailVerifiedAt)) return null;
  return {...record,rank};
}

async function accountSessionFromRequest(req) {
  const token=secureAccounts.parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return token?accountSessionFromToken(token):null;
}

function issueSocketLoginCode(session) {
  const code=secureAccounts.randomToken(24);
  socketLoginCodes.set(secureAccounts.hashToken(code),{
    accountId:session.accountId,
    nameKey:session.nameKey,
    level:session.level,
    expiresAt:Date.now()+60*1000,
  });
  return code;
}

function consumeSocketLoginCode(code,name) {
  const hash=secureAccounts.hashToken(code);
  const record=socketLoginCodes.get(hash);
  socketLoginCodes.delete(hash);
  if (!record||record.expiresAt<Date.now()||record.nameKey!==playerNameKey(name)) return null;
  return record;
}

function requestOriginAllowed(req) {
  const origin=req.get('origin');
  if (!origin) return true;
  let expected;
  try{expected=PUBLIC_BASE_URL?new URL(PUBLIC_BASE_URL).origin:`${req.protocol}://${req.get('host')}`;}
  catch{return false;}
  return origin===expected;
}

function requireSameOrigin(req,res,next) {
  if (!requestOriginAllowed(req)) return res.status(403).json({ok:false,reason:'bad_origin'});
  res.set('Cache-Control','no-store');
  next();
}

async function requireSecureSession(req,res,next) {
  try{
    const session=await accountSessionFromRequest(req);
    if (!session||session.level!=='secure') {
      return res.status(401).json({ok:false,reason:'secure_login_required'});
    }
    req.accountSession=session;
    next();
  }catch(error){
    console.error('session lookup err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
}

async function requireAccountSession(req,res,next) {
  try{
    const session=await accountSessionFromRequest(req);
    if (!session) return res.status(401).json({ok:false,reason:'login_required'});
    req.accountSession=session;
    next();
  }catch(error){
    console.error('account session lookup err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
}

async function sendAccountEmail({to,subject,text,idempotencyKey,from=EMAIL_FROM}) {
  if (process.env.NODE_ENV==='test'&&process.env.EMAIL_TEST_MODE==='1') return {id:'test-email'};
  if (!RESEND_API_KEY||!from) throw new Error('email_not_configured');
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{
      authorization:`Bearer ${RESEND_API_KEY}`,
      'content-type':'application/json',
      'idempotency-key':idempotencyKey,
    },
    body:JSON.stringify({from,to:[to],subject,text}),
  });
  const result=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(result.message||`email_http_${response.status}`);
  return result;
}

async function finishHttpLogin(req,res,rank,{level='secure',persistent=true}={}) {
  // A successful login replaces the session currently held by this browser.
  // Removing that exact old token prevents account switching from leaving a
  // still-valid, unused session behind until its natural expiry.
  const previousToken=secureAccounts.parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (previousToken) {
    const previousHash=secureAccounts.hashToken(previousToken);
    if (db) await db.collection('account_sessions').deleteOne({tokenHash:previousHash});
    memorySessions.delete(previousHash);
  }
  const {token,record}=await createAccountSession(rank,{level,persistent});
  setSessionCookie(res,req,token,persistent);
  return {
    ok:true,
    name:rank.name,
    accountId:rank.accountId,
    level,
    socketCode:issueSocketLoginCode(record),
  };
}

function passwordFailure(rank) {
  rank.secureFailedAttempts=(rank.secureFailedAttempts||0)+1;
  if (rank.secureFailedAttempts>=5) {
    rank.secureFailedAttempts=0;
    rank.secureLockedUntil=Date.now()+PASSWORD_LOCKOUT_MS;
    return {reason:'secure_locked',retryAt:rank.secureLockedUntil};
  }
  return {reason:'wrong_password',attemptsLeft:5-rank.secureFailedAttempts};
}

async function revokeAccountSessions(accountId) {
  if (db) await db.collection('account_sessions').deleteMany({accountId});
  for (const [hash,session] of memorySessions) {
    if (session.accountId===accountId) memorySessions.delete(hash);
  }
}

function accountSetupMissing() {
  const missing=[];
  if (!db) missing.push('MongoDB');
  if (!RESEND_API_KEY) missing.push('Resend API key');
  if (!EMAIL_FROM) missing.push('verified sender email');
  return missing;
}

function validPublicBaseUrl() {
  try{
    const url=new URL(PUBLIC_BASE_URL);
    return url.protocol==='https:'&&!url.username&&!url.password&&url.origin===PUBLIC_BASE_URL;
  }catch{
    return false;
  }
}

function commerceSetupMissing(productKey) {
  const missing=[];
  if (!db) missing.push('MongoDB');
  if (!stripe) missing.push('Stripe secret key');
  if (!STRIPE_WEBHOOK_SECRET) missing.push('Stripe webhook secret');
  if (!validPublicBaseUrl()) missing.push('valid HTTPS public base URL');
  if (productKey&&!premiumShop.priceIdFor(productKey)) missing.push('Stripe Price ID');
  return missing;
}

function publicAccountSummary(rank,session) {
  const secured=!!(rank.secureEmail&&rank.passwordHash&&rank.emailVerifiedAt);
  const sameSession=!!(session&&session.accountId===rank.accountId);
  return {
    secured,
    hasPin:!!rank.pinHash,
    sessionLevel:sameSession?session.level:null,
    email:sameSession&&secured?secureAccounts.maskEmail(rank.secureEmail):'',
    upgradePending:!!rank.pendingSecureEmail,
    accountSetupReady:accountSetupMissing().length===0,
  };
}

function sessionAccountSummary(session) {
  const rank=session&&findRankByAccountId(session.accountId);
  if (!rank||session.nameKey!==playerNameKey(rank.name)) return {signedIn:false};
  ensureCosmeticState(rank);
  const tier=getTier(rank.sr);
  return {
    signedIn:true,
    name:rank.name,
    level:session.level,
    secured:!!(rank.secureEmail&&rank.passwordHash&&rank.emailVerifiedAt),
    email:rank.secureEmail?secureAccounts.maskEmail(rank.secureEmail):'',
    accountSetupReady:accountSetupMissing().length===0,
    shards:rank.shards||0,
    sr:rank.sr,
    worldRank:getPlayerWorldRank(rank.name),
    tier:{name:tier.name,color:tier.color,emoji:tier.emoji},
  };
}

app.post('/api/account/pin-auth',requireSameOrigin,async(req,res)=>{
  try{
    const {name,pin,mode,remember}=asObject(req.body);
    const cleanName=cleanPlayerName(name);
    if (!cleanName) return res.status(400).json({ok:false,reason:'invalid_name'});
    if (!isValidPin(pin)) return res.status(400).json({ok:false,reason:'invalid_pin'});
    const state=getAccountState(cleanName);
    if (state.state==='secured'||state.state==='secure_locked') {
      return res.status(409).json({ok:false,reason:'password_required'});
    }
    if (mode==='create') {
      if (state.state!=='none') return res.status(409).json({ok:false,reason:'already_exists'});
      createAccount(cleanName,pin);
    }else{
      const result=verifyPin(cleanName,pin);
      if (!result.ok) return res.status(result.reason==='locked'?429:401).json(result);
    }
    const rank=getPlayerRank(cleanName);
    const result=await finishHttpLogin(req,res,rank,{level:'pin',persistent:remember!==false});
    res.json(result);
  }catch(error){
    console.error('PIN HTTP auth err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
});

app.post('/api/account/login',requireSameOrigin,async(req,res)=>{
  try{
    const {name,password,remember}=asObject(req.body);
    const rank=rankData[playerNameKey(name)];
    if (!rank||!rank.secureEmail||!rank.passwordHash||!rank.emailVerifiedAt) {
      return res.status(401).json({ok:false,reason:'wrong_password'});
    }
    if (rank.secureLockedUntil&&rank.secureLockedUntil>Date.now()) {
      return res.status(429).json({ok:false,reason:'secure_locked',retryAt:rank.secureLockedUntil});
    }
    const correct=await secureAccounts.verifyPassword(password,rank.passwordSalt,rank.passwordHash);
    if (!correct) {
      const failure=passwordFailure(rank);
      await persistRankRecord(rank);
      return res.status(failure.reason==='secure_locked'?429:401).json({ok:false,...failure});
    }
    rank.secureFailedAttempts=0;
    rank.secureLockedUntil=0;
    await persistRankRecord(rank);
    res.json(await finishHttpLogin(req,res,rank,{level:'secure',persistent:remember!==false}));
  }catch(error){
    console.error('password login err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
});

app.post('/api/account/upgrade',requireSameOrigin,async(req,res)=>{
  try{
    const missing=accountSetupMissing();
    if (missing.length) return res.status(503).json({ok:false,reason:'setup_required',missing});
    const {name,pin,email,password}=asObject(req.body);
    const cleanName=cleanPlayerName(name);
    const normalizedEmail=secureAccounts.normalizeEmail(email);
    if (!cleanName) return res.status(400).json({ok:false,reason:'invalid_name'});
    if (!normalizedEmail) return res.status(400).json({ok:false,reason:'invalid_email'});
    if (!secureAccounts.validPassword(password)) return res.status(400).json({ok:false,reason:'invalid_password'});
    const pinResult=verifyPin(cleanName,pin);
    if (!pinResult.ok) return res.status(pinResult.reason==='locked'?429:401).json(pinResult);
    const rank=getPlayerRank(cleanName);
    if (rank.secureEmail&&rank.emailVerifiedAt) return res.status(409).json({ok:false,reason:'already_secured'});
    if (rank.verificationSentAt&&Date.now()-rank.verificationSentAt<60*1000) {
      return res.status(429).json({ok:false,reason:'email_cooldown',retryAt:rank.verificationSentAt+60*1000});
    }
    const existing=findRankBySecureEmail(normalizedEmail);
    if (existing&&existing.accountId!==rank.accountId) {
      return res.status(409).json({ok:false,reason:'email_in_use'});
    }
    const passwordRecord=await secureAccounts.hashPassword(password);
    const code=secureAccounts.randomNumericCode();
    rank.pendingSecureEmail=normalizedEmail;
    rank.pendingPasswordHash=passwordRecord.hash;
    rank.pendingPasswordSalt=passwordRecord.salt;
    rank.emailVerificationHash=secureAccounts.hashToken(code);
    rank.emailVerificationExpiresAt=Date.now()+EMAIL_CODE_MAX_AGE_MS;
    rank.emailVerificationAttempts=0;
    rank.verificationSentAt=Date.now();
    await persistRankRecord(rank);
    await sendAccountEmail({
      to:normalizedEmail,
      subject:'Your Arena.io verification code',
      text:`Your Arena.io verification code is ${code}. It expires in 15 minutes. If you did not request this, ignore this email.`,
      idempotencyKey:`verify-${rank.accountId}-${rank.emailVerificationExpiresAt}`,
    });
    res.json({
      ok:true,
      state:'verification_sent',
      email:secureAccounts.maskEmail(normalizedEmail),
      ...(process.env.NODE_ENV==='test'&&process.env.EMAIL_TEST_MODE==='1'?{testCode:code}:{}),
    });
  }catch(error){
    console.error('secure account upgrade err:',error.message);
    res.status(502).json({ok:false,reason:error.message==='email_not_configured'?'email_unavailable':'server_error'});
  }
});

app.post('/api/account/verify-email',requireSameOrigin,async(req,res)=>{
  try{
    const {name,code,remember}=asObject(req.body);
    const rank=rankData[playerNameKey(name)];
    if (!rank||!rank.pendingSecureEmail||!rank.emailVerificationHash) {
      return res.status(400).json({ok:false,reason:'verification_not_started'});
    }
    if (rank.emailVerificationExpiresAt<Date.now()) {
      return res.status(410).json({ok:false,reason:'code_expired'});
    }
    rank.emailVerificationAttempts=(rank.emailVerificationAttempts||0)+1;
    if (rank.emailVerificationAttempts>5) {
      await persistRankRecord(rank);
      return res.status(429).json({ok:false,reason:'too_many_codes'});
    }
    if (!secureAccounts.safeEqualHash(String(code||''),rank.emailVerificationHash)) {
      await persistRankRecord(rank);
      return res.status(401).json({ok:false,reason:'wrong_code'});
    }
    rank.secureEmail=rank.pendingSecureEmail;
    rank.passwordHash=rank.pendingPasswordHash;
    rank.passwordSalt=rank.pendingPasswordSalt;
    rank.emailVerifiedAt=new Date().toISOString();
    rank.secureFailedAttempts=0;
    rank.secureLockedUntil=0;
    delete rank.pinHash;delete rank.pinSalt;delete rank.failedAttempts;delete rank.lockedUntil;
    delete rank.pendingSecureEmail;delete rank.pendingPasswordHash;delete rank.pendingPasswordSalt;
    delete rank.emailVerificationHash;delete rank.emailVerificationExpiresAt;delete rank.emailVerificationAttempts;
    delete rank.verificationSentAt;
    await persistRankRecord(rank);
    await revokeAccountSessions(rank.accountId);
    const result=await finishHttpLogin(req,res,rank,{level:'secure',persistent:remember!==false});
    res.json(result);
  }catch(error){
    console.error('email verification err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
});

app.post('/api/account/recover',requireSameOrigin,async(req,res)=>{
  const generic={ok:true,state:'recovery_sent'};
  try{
    const {name,email}=asObject(req.body);
    const rank=rankData[playerNameKey(name)];
    const normalized=secureAccounts.normalizeEmail(email);
    if (!rank||!normalized||rank.secureEmail!==normalized||!rank.emailVerifiedAt) return res.json(generic);
    if (rank.passwordResetSentAt&&Date.now()-rank.passwordResetSentAt<60*1000) return res.json(generic);
    const code=secureAccounts.randomNumericCode();
    rank.passwordResetHash=secureAccounts.hashToken(code);
    rank.passwordResetExpiresAt=Date.now()+EMAIL_CODE_MAX_AGE_MS;
    rank.passwordResetAttempts=0;
    rank.passwordResetSentAt=Date.now();
    await persistRankRecord(rank);
    await sendAccountEmail({
      to:normalized,
      subject:'Reset your Arena.io password',
      text:`Your Arena.io password reset code is ${code}. It expires in 15 minutes. If you did not request this, ignore this email.`,
      idempotencyKey:`reset-${rank.accountId}-${rank.passwordResetExpiresAt}`,
    });
    res.json({
      ...generic,
      ...(process.env.NODE_ENV==='test'&&process.env.EMAIL_TEST_MODE==='1'?{testCode:code}:{}),
    });
  }catch(error){
    console.error('password recovery err:',error.message);
    res.json(generic);
  }
});

app.post('/api/account/reset-password',requireSameOrigin,async(req,res)=>{
  try{
    const {name,email,code,password,remember}=asObject(req.body);
    const rank=rankData[playerNameKey(name)];
    if (!rank||rank.secureEmail!==secureAccounts.normalizeEmail(email)||!rank.passwordResetHash) {
      return res.status(400).json({ok:false,reason:'reset_not_started'});
    }
    if (!secureAccounts.validPassword(password)) return res.status(400).json({ok:false,reason:'invalid_password'});
    if (rank.passwordResetExpiresAt<Date.now()) return res.status(410).json({ok:false,reason:'code_expired'});
    rank.passwordResetAttempts=(rank.passwordResetAttempts||0)+1;
    if (rank.passwordResetAttempts>5) {
      await persistRankRecord(rank);
      return res.status(429).json({ok:false,reason:'too_many_codes'});
    }
    if (!secureAccounts.safeEqualHash(String(code||''),rank.passwordResetHash)) {
      await persistRankRecord(rank);
      return res.status(401).json({ok:false,reason:'wrong_code'});
    }
    const passwordRecord=await secureAccounts.hashPassword(password);
    rank.passwordHash=passwordRecord.hash;
    rank.passwordSalt=passwordRecord.salt;
    rank.secureFailedAttempts=0;rank.secureLockedUntil=0;
    delete rank.passwordResetHash;delete rank.passwordResetExpiresAt;delete rank.passwordResetAttempts;
    delete rank.passwordResetSentAt;
    await persistRankRecord(rank);
    await revokeAccountSessions(rank.accountId);
    res.json(await finishHttpLogin(req,res,rank,{level:'secure',persistent:remember!==false}));
  }catch(error){
    console.error('password reset err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
});

app.post('/api/account/logout',requireSameOrigin,async(req,res)=>{
  try{
    const token=secureAccounts.parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const tokenHash=secureAccounts.hashToken(token);
      if (db) await db.collection('account_sessions').deleteOne({tokenHash});
      memorySessions.delete(tokenHash);
    }
    setSessionCookie(res,req,'',false);
    res.json({ok:true});
  }catch(error){
    res.status(500).json({ok:false,reason:'server_error'});
  }
});

app.post('/api/account/delete',requireSameOrigin,requireAccountSession,async(req,res)=>{
  try{
    const rank=req.accountSession.rank;
    const accountId=rank.accountId;
    const key=playerNameKey(rank.name);
    const {accountName,credential}=asObject(req.body);
    if (playerNameKey(accountName)!==key) {
      return res.status(400).json({ok:false,reason:'name_confirmation_mismatch'});
    }
    if (typeof credential!=='string'||!credential) {
      return res.status(400).json({ok:false,reason:'credential_required'});
    }

    if (rank.secureEmail&&rank.passwordHash&&rank.emailVerifiedAt) {
      if (req.accountSession.level!=='secure') {
        return res.status(401).json({ok:false,reason:'secure_login_required'});
      }
      if (rank.secureLockedUntil&&rank.secureLockedUntil>Date.now()) {
        return res.status(429).json({ok:false,reason:'secure_locked',retryAt:rank.secureLockedUntil});
      }
      const correct=await secureAccounts.verifyPassword(credential,rank.passwordSalt,rank.passwordHash);
      if (!correct) {
        const failure=passwordFailure(rank);
        await persistRankRecord(rank);
        return res.status(failure.reason==='secure_locked'?429:401).json({ok:false,...failure});
      }
    }else{
      const result=verifyPin(rank.name,String(credential||''));
      if (!result.ok) return res.status(result.reason==='locked'?429:401).json(result);
    }

    // Remove live socket access before deleting stored data. The room cleanup
    // can emit a final named leave event, which is then removed below.
    for (const client of io.sockets.sockets.values()) {
      if (client.data.accountSession?.accountId===accountId) {
        if (typeof client.data.accountDeletionCleanup==='function') {
          client.data.accountDeletionCleanup(rank.name);
        }else{
          client.data.accountSession=null;
          client.emit('accountDeleted',{name:rank.name});
        }
      }
    }

    // Remove player-facing data first. Stripe purchase documents remain for
    // refunds/accounting, but no longer resolve to an active player account.
    delete dailyProgress[key];
    weekly.entries=normalizeWeeklyEntries(weekly.entries)
      .filter(entry=>playerNameKey(entry.name)!==key);
    if (weekly.prevWeek) {
      weekly.prevWeek.entries=normalizeWeeklyEntries(weekly.prevWeek.entries)
        .filter(entry=>playerNameKey(entry.name)!==key);
    }
    await analytics.deletePlayerData(rank.name);
    if (db) {
      await db.collection('daily_progress').deleteOne({key});
      await db.collection('weekly').updateMany(
        {'entries.name':rank.name},
        {$pull:{entries:{name:rank.name}}}
      );
      await db.collection('purchases').updateMany(
        {accountId},
        {$set:{accountDeletedAt:new Date()}}
      );
      await db.collection('account_sessions').deleteMany({accountId});
      await db.collection('ranks').deleteOne({$or:[{key},{accountId}]});
    }
    for (const [hash,session] of memorySessions) {
      if (session.accountId===accountId) memorySessions.delete(hash);
    }
    for (const [hash,code] of socketLoginCodes) {
      if (code.accountId===accountId) socketLoginCodes.delete(hash);
    }
    await socialSystem.deleteAccount(key);
    delete rankData[key];
    await saveWeekly();
    setSessionCookie(res,req,'',false);
    res.json({ok:true,name:rank.name});
  }catch(error){
    console.error('delete account err:',error.message);
    res.status(500).json({ok:false,reason:'server_error'});
  }
});

app.post('/api/shop/checkout',requireSameOrigin,requireSecureSession,async(req,res)=>{
  try{
    const {productKey:rawProductKey,checkoutRequestId,platform:rawPlatform}=asObject(req.body);
    const productKey=String(rawProductKey||'');
    const platform=cleanClientPlatform(rawPlatform);
    if (typeof checkoutRequestId!=='string'||!/^[A-Za-z0-9-]{16,80}$/.test(checkoutRequestId)) {
      return res.status(400).json({ok:false,reason:'invalid_checkout_request'});
    }
    const product=premiumShop.PRODUCTS[productKey];
    if (!product) return res.status(400).json({ok:false,reason:'unknown_product'});
    const missing=commerceSetupMissing(productKey);
    if (missing.length) return res.status(503).json({ok:false,reason:'setup_required',missing});
    const rank=req.accountSession.rank;
    if (rank.premiumEntitlements&&rank.premiumEntitlements[productKey]?.status==='active'
        && productKey.endsWith('_pack')) {
      return res.status(409).json({ok:false,reason:'already_owned'});
    }
    const options={
      mode:'payment',
      line_items:[{price:premiumShop.priceIdFor(productKey),quantity:1}],
      customer_email:rank.secureEmail,
      client_reference_id:rank.accountId,
      metadata:{accountId:rank.accountId,productKey,nameKey:playerNameKey(rank.name)},
      success_url:`${PUBLIC_BASE_URL}/?shop_payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`${PUBLIC_BASE_URL}/?shop_payment=cancelled`,
      allow_promotion_codes:true,
    };
    if (process.env.STRIPE_AUTOMATIC_TAX==='true') options.automatic_tax={enabled:true};
    const checkout=await stripe.checkout.sessions.create(options,{
      idempotencyKey:`checkout-${rank.accountId}-${productKey}-${checkoutRequestId}`,
    });
    analytics.logEvent('checkout_start',{
      name:rank.name,
      productKey,
      platform,
    });
    res.json({ok:true,url:checkout.url});
  }catch(error){
    console.error('create Checkout Session err:',error.message);
    res.status(502).json({ok:false,reason:'checkout_failed'});
  }
});

app.get('/api/shop/checkout-status',requireSecureSession,async(req,res)=>{
  try{
    if (!stripe) return res.status(503).json({ok:false,reason:'setup_required'});
    const sessionId=String(req.query.session_id||'');
    if (!/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) {
      return res.status(400).json({ok:false,reason:'invalid_session'});
    }
    const checkout=await stripe.checkout.sessions.retrieve(sessionId);
    if (checkout.metadata?.accountId!==req.accountSession.accountId) {
      return res.status(403).json({ok:false,reason:'wrong_account'});
    }
    if (checkout.payment_status==='paid') await fulfillCheckout(checkout);
    res.json({ok:true,status:checkout.payment_status,shop:getShopPayload(req.accountSession.rank.name,req.accountSession)});
  }catch(error){
    console.error('Checkout status err:',error.message);
    res.status(502).json({ok:false,reason:'status_failed'});
  }
});

async function fulfillCheckout(checkout) {
  if (!db||checkout.payment_status!=='paid') return {ok:false,reason:'not_paid'};
  const productKey=checkout.metadata&&checkout.metadata.productKey;
  const accountId=checkout.metadata&&checkout.metadata.accountId;
  const product=premiumShop.PRODUCTS[productKey];
  const rank=findRankByAccountId(accountId);
  if (!product||!rank) throw new Error('invalid_checkout_metadata');
  ensureCosmeticState(rank);
  const lineItems=await stripe.checkout.sessions.listLineItems(checkout.id,{limit:10});
  const expectedPrice=premiumShop.priceIdFor(productKey);
  if (!lineItems.data.some(item=>item.price&&item.price.id===expectedPrice&&item.quantity===1)) {
    throw new Error('checkout_price_mismatch');
  }
  const alreadyFulfilled=rank.fulfilledCheckoutIds.includes(checkout.id);
  const grant=premiumShop.grantProduct(rank,productKey,checkout.id,checkout.created*1000);
  if (!alreadyFulfilled) await persistRankRecord(rank);
  await db.collection('purchases').updateOne(
    {checkoutSessionId:checkout.id},
    {$setOnInsert:{
      checkoutSessionId:checkout.id,
      paymentIntentId:typeof checkout.payment_intent==='string'?checkout.payment_intent:null,
      accountId,
      productKey,
      amountTotal:checkout.amount_total,
      currency:checkout.currency,
      platform:'stripe',
      status:'paid',
      createdAt:new Date(),
    }},
    {upsert:true}
  );
  if (!alreadyFulfilled) {
    analytics.logEvent('premium_purchase',{
      name:rank.name,productKey,amount:checkout.amount_total,
      currency:checkout.currency,platform:'stripe',
    });
  }
  let receiptError=null;
  try{
    const purchase=await db.collection('purchases').findOne({checkoutSessionId:checkout.id});
    if (purchase&&purchase.status==='paid'&&!purchase.receiptEmailSentAt) {
      if (!rank.secureEmail||!rank.emailVerifiedAt) throw new Error('verified_purchase_email_missing');
      const receipt=purchaseReceipts.buildPurchaseReceipt({playerName:rank.name,product,checkout});
      const sent=await sendAccountEmail({
        from:PURCHASE_EMAIL_FROM,
        to:rank.secureEmail,
        subject:receipt.subject,
        text:receipt.text,
        idempotencyKey:`purchase-receipt-${checkout.id}`,
      });
      await db.collection('purchases').updateOne(
        {checkoutSessionId:checkout.id,receiptEmailSentAt:{$exists:false}},
        {$set:{receiptEmailSentAt:new Date(),receiptEmailId:sent&&sent.id||null}}
      );
    }
  }catch(error){
    receiptError=error;
    console.error('purchase receipt email err:',error.message);
  }
  return {...grant,receiptError};
}

async function revokeRefundedPurchase(charge) {
  if (!db||!charge||!charge.refunded||typeof charge.payment_intent!=='string') return;
  const purchase=await db.collection('purchases').findOne({paymentIntentId:charge.payment_intent,status:'paid'});
  if (!purchase) throw new Error('refund_purchase_not_ready');
  const rank=findRankByAccountId(purchase.accountId);
  if (!rank) {
    // The player may have exercised account deletion after purchasing. Keep
    // the retained financial record refundable without recreating their data.
    await db.collection('purchases').updateOne(
      {checkoutSessionId:purchase.checkoutSessionId},
      {$set:{status:'refunded',refundedAt:new Date(),chargeId:charge.id}}
    );
    return;
  }
  ensureCosmeticState(rank);
  premiumShop.revokeProduct(rank,purchase.productKey,purchase.checkoutSessionId);
  ensureCosmeticState(rank);
  await persistRankRecord(rank);
  await db.collection('purchases').updateOne(
    {checkoutSessionId:purchase.checkoutSessionId},
    {$set:{status:'refunded',refundedAt:new Date(),chargeId:charge.id}}
  );
}

async function handleStripeWebhook(req,res) {
  if (!stripe||!STRIPE_WEBHOOK_SECRET||!db) {
    return res.status(503).json({ok:false,reason:'commerce_not_configured'});
  }
  let event;
  try{
    event=stripe.webhooks.constructEvent(req.body,req.get('stripe-signature'),STRIPE_WEBHOOK_SECRET);
  }catch(error){
    console.warn('Stripe webhook signature rejected:',error.message);
    return res.status(400).send('Invalid signature');
  }
  if (stripeEventsInFlight.has(event.id)) return res.json({received:true,duplicate:true});
  stripeEventsInFlight.add(event.id);
  try{
    const already=await db.collection('stripe_events').findOne({eventId:event.id});
    if (already) return res.json({received:true,duplicate:true});
    if (event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded') {
      const fulfillment=await fulfillCheckout(event.data.object);
      // The purchase remains granted if Resend is temporarily unavailable, but
      // returning an error lets Stripe retry this event. The checkout ID is used
      // as Resend's idempotency key, so the customer receives at most one email.
      if (fulfillment.receiptError) throw fulfillment.receiptError;
    }else if(event.type==='charge.refunded'){
      await revokeRefundedPurchase(event.data.object);
    }
    await db.collection('stripe_events').insertOne({eventId:event.id,type:event.type,processedAt:new Date()});
    res.json({received:true});
  }catch(error){
    if (error&&error.code===11000) return res.json({received:true,duplicate:true});
    console.error('Stripe webhook processing err:',error.message);
    res.status(500).json({received:false});
  }finally{
    stripeEventsInFlight.delete(event.id);
  }
}

function getWorldRankings() {
  return Object.values(rankData)
    .filter(p => p&&cleanPlayerName(p.name)&&Number.isFinite(p.sr)&&p.sr > 0)
    .sort((a, b) => b.sr - a.sr)
    .map((p, i) => {
      const t = getTier(p.sr);
      return { rank: i + 1, name: p.name, sr: p.sr, color: p.color || '#e74c3c',
               tier: { name: t.name, color: t.color, emoji: t.emoji, index: t.index } };
    });
}

function getPlayerWorldRank(name) {
  const key=playerNameKey(name);
  if (!key) return null;
  const sorted = Object.values(rankData)
    .filter(p=>p&&cleanPlayerName(p.name)&&Number.isFinite(p.sr))
    .sort((a, b) => b.sr - a.sr);
  const idx = sorted.findIndex(p => playerNameKey(p.name) === key);
  return idx === -1 ? null : idx + 1;
}

function computeSRDelta(opts) {
  const { isWin, isLoss, kills, deaths, currentSR } = opts;
  const tier = getTier(currentSR);

  // Fortnite-style curve: generous early, punishing late.
  // gainMod: multiplier on SR earned | lossMod: multiplier on SR lost
  // cap: max gain per round | floor: max loss per round
  const TIER_PARAMS = [
    { gainMod: 1.60, lossMod: 0.45, cap: 120, floor: -12 }, // Bronze
    { gainMod: 1.35, lossMod: 0.60, cap: 100, floor: -18 }, // Silver
    { gainMod: 1.10, lossMod: 0.80, cap:  85, floor: -25 }, // Gold
    { gainMod: 0.92, lossMod: 1.00, cap:  70, floor: -32 }, // Platinum
    { gainMod: 0.78, lossMod: 1.15, cap:  55, floor: -40 }, // Diamond
    { gainMod: 0.65, lossMod: 1.30, cap:  45, floor: -48 }, // Master
    { gainMod: 0.50, lossMod: 1.50, cap:  35, floor: -55 }, // Champion
  ];
  const p = TIER_PARAMS[Math.min(tier.index, TIER_PARAMS.length - 1)];

  const SR_PER_KILL  = 14;
  const SR_PER_DEATH =  9;
  const WIN_BONUS    = 20;
  const MID_BONUS    =  6;
  const LOSS_BONUS   =  0;

  const placementBonus = isWin ? WIN_BONUS : isLoss ? LOSS_BONUS : MID_BONUS;
  const gainRaw = (kills * SR_PER_KILL + placementBonus) * p.gainMod;
  const lossRaw =  deaths * SR_PER_DEATH * p.lossMod;

  let delta = Math.round(gainRaw - lossRaw);
  delta = Math.max(p.floor, Math.min(p.cap, delta));

  // Arena.io uses permanent rank tiers: once a player earns a tier, normal
  // match results can never demote them below that tier's starting SR.
  //
  // A player who contributes at least one kill should also feel that the match
  // moved them forward. Placement and survival still control how quickly they
  // progress, while a poor zero-kill round may lose SR within the current tier.
  if (kills > 0) delta = Math.max(delta, Math.min(20, kills * 3));
  if (tier.index === 0 && delta < 0 && kills === 0) delta = 0;

  const oldSR = Number.isFinite(currentSR) ? currentSR : STARTING_SR;
  const newSR = Math.max(tier.min, oldSR + delta);
  return { delta:newSR-oldSR, newSR };
}

function recordRankResult(room) {
  if (room.mode !== 'ranked') return;
  const realPlayers = Object.values(room.players).filter(p => !p.isBot);
  if (realPlayers.length === 0) return;
  const allPlayers  = Object.values(room.players);
  const totalKills  = allPlayers.reduce((s, p) => s + p.kills, 0);
  const totalDeaths = allPlayers.reduce((s, p) => s + p.deaths, 0);
  const lobbySize   = allPlayers.length;
  // Bots are real competitors for placement. A small game can therefore award
  // meaningful SR immediately, even when one human is the only real player.
  const sortedAll = allPlayers.slice().sort((a, b) => b.kills - a.kills || b.score - a.score);
  const sorted = realPlayers.slice().sort((a,b)=>sortedAll.indexOf(a)-sortedAll.indexOf(b));
  const count  = sorted.length;
  const results = {};
  sorted.forEach((p) => {
    const idx=sortedAll.indexOf(p);
    const placement = lobbySize <= 1 ? 0 : idx / (lobbySize - 1);
    const isWin  = placement <= 0.33;
    const isLoss = placement >= 0.67;
    const isTie  = !isWin && !isLoss;
    const rank    = getPlayerRank(p.name);
    const rankedKills=Math.max(0,p.kills||0);
    const { delta, newSR } = computeSRDelta({
      isWin, isLoss, kills: rankedKills, deaths: p.deaths,
      roundKills: totalKills, roundDeaths: totalDeaths,
      lobbySize, currentSR: rank.sr,
    });
    const oldSR   = rank.sr;
    const oldTier = getTier(oldSR);
    rank.sr = newSR; rank.name = p.name; rank.color = p.color;
    rankData[playerNameKey(p.name)] = rank;
    // Save this player's updated rank to MongoDB
    savePlayerRank(p.name).catch(e => console.error('recordRankResult save err:', e.message));
    const newTier    = getTier(newSR);
    results[p.id] = {
      delta, oldSR, newSR,
      kills: p.kills, deaths: p.deaths, score: p.score,
      creditedKills:rankedKills,
      placementIdx: idx, worldRank:null,
      oldTier: { name:oldTier.name, color:oldTier.color, emoji:oldTier.emoji, index:oldTier.index },
      newTier: { name:newTier.name, color:newTier.color, emoji:newTier.emoji, index:newTier.index, glow:newTier.glow },
      rankedUp:   newTier.index > oldTier.index,
      rankedDown: newTier.index < oldTier.index,
      progress: srProgressInTier(newSR),
      isWin, isLoss, isTie,
    };
  });
  // Calculate placements only after every player in this round has received
  // their new SR; otherwise the first processed player can be ranked against
  // opponents' stale pre-round values.
  for (const p of realPlayers) {
    if (results[p.id]) results[p.id].worldRank=getPlayerWorldRank(p.name);
  }
  for (const p of realPlayers) {
    const r = results[p.id];
    if (r) io.to(p.id).emit('rankResult', r);
  }
}

// ── Weekly leaderboard ────────────────────────────────────────────────────────
function getWeekKey() {
  return calendar.getIsoWeekKey();
}

async function loadWeeklyFromDB() {
  const key = getWeekKey();
  try {
    const current = await db.collection('weekly').findOne({ weekKey: key });
    const prev    = await db.collection('weekly').findOne({ weekKey: { $ne: key } }, { sort: { weekKey: -1 } });
    weekly = {
      weekKey: key,
      entries: normalizeWeeklyEntries(current && current.entries),
      prevWeek: prev ? { weekKey: prev.weekKey, entries: normalizeWeeklyEntries(prev.entries) } : null,
    };
    console.log(`Loaded weekly leaderboard for ${key} (${weekly.entries.length} entries)`);
  } catch(e) {
    console.error('loadWeeklyFromDB error:', e.message);
    weekly = { weekKey: key, entries: [], prevWeek: null };
  }
}

async function saveWeekly() {
  if (!db) return;
  try {
    await db.collection('weekly').updateOne(
      { weekKey: weekly.weekKey },
      { $set: { weekKey: weekly.weekKey, entries: weekly.entries } },
      { upsert: true }
    );
  } catch(e) { console.error('saveWeekly error:', e.message); }
}

function ensureCurrentWeek() {
  const key = getWeekKey();
  if (weekly.weekKey === key) return false;
  const previous = weekly.weekKey
    ? { weekKey:weekly.weekKey, entries:normalizeWeeklyEntries(weekly.entries) }
    : weekly.prevWeek;
  weekly = { weekKey:key, entries:[], prevWeek:previous || null };
  saveWeekly().catch(e => console.error('weekly rollover save err:', e.message));
  return true;
}

// The interval is a background broadcast, while getters and writes also call
// ensureCurrentWeek so the first action after midnight Monday cannot land in
// last week's board.
setInterval(() => {
  if (ensureCurrentWeek()) io.emit('weeklyLeaderboard', getWeeklyLB());
}, 60 * 1000);

function getWeeklyLB() {
  ensureCurrentWeek();
  const currentEntries=normalizeWeeklyEntries(weekly.entries);
  const previousEntries=weekly.prevWeek?normalizeWeeklyEntries(weekly.prevWeek.entries):[];
  return {
    weekKey: weekly.weekKey,
    entries: currentEntries.slice(0, WEEKLY_LB_SIZE),
    prevWeek: weekly.prevWeek ? { weekKey: weekly.prevWeek.weekKey, entries: previousEntries.slice(0,WEEKLY_LB_SIZE) } : null,
    resetsAt: getNextMonday(),
  };
}

function normalizeWeeklyEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(entry => entry && typeof entry.name === 'string' && entry.name.trim())
    .map(entry => ({
      name: entry.name.trim().slice(0, 16),
      color: typeof entry.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(entry.color)
        ? entry.color
        : '#888888',
      kills: Number.isFinite(Number(entry.kills)) ? Math.max(0, Math.floor(Number(entry.kills))) : 0,
      score: Number.isFinite(Number(entry.score)) ? Math.max(0, Math.floor(Number(entry.score))) : 0,
    }))
    .sort((a,b) => b.kills !== a.kills ? b.kills-a.kills : b.score-a.score);
}

function getNextMonday() {
  return calendar.getNextMonday();
}

function recordWeeklyKill(name, color, kills, score) {
  ensureCurrentWeek();
  if (name.startsWith('__bot__')) return;
  weekly.entries=normalizeWeeklyEntries(weekly.entries);
  const key = name.toLowerCase();
  const idx = weekly.entries.findIndex(e => e.name.toLowerCase() === key);
  if (idx >= 0) {
    weekly.entries[idx].kills += kills;
    weekly.entries[idx].score += score;
    weekly.entries[idx].color  = color;
  } else {
    weekly.entries.push({ name, color, kills, score });
  }
  weekly.entries.sort((a,b) => b.kills !== a.kills ? b.kills-a.kills : b.score-a.score);
  if (weekly.entries.length > 100) weekly.entries = weekly.entries.slice(0,100);
}

function getDayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// Shifts a "YYYY-MM-DD" dayKey by `delta` days (UTC) and returns the new dayKey string.
// Used to check streak continuity (is rec.dayKey exactly one day after the player's
// last credited streak day?) without any reliance on wall-clock timing/race windows.
function addDaysToDayKey(dayKey, delta) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

// ── Daily & weekly challenges ────────────────────────────────────────────────
// Three category-diverse challenges are generated deterministically for each
// day and week. TDM is absent from the challenge definitions by design.
let dailyProgress = {};
let currentDayKey = getDayKey();
let dailyChallenges = challengeSystem.generateDailyChallenges(currentDayKey);

function ensureCurrentDay() {
  const today = getDayKey();
  if (today === currentDayKey) return false;
  currentDayKey = today;
  dailyChallenges = challengeSystem.generateDailyChallenges(today);

  // Break streaks for anyone who missed yesterday. This runs synchronously on
  // the first request after rollover as well as from the background interval,
  // preventing progress made in the first minute of a day from being reset.
  const yesterday = addDaysToDayKey(today, -1);
  for (const key of Object.keys(rankData)) {
    const rank = rankData[key];
    if (!rank || !rank.streak) continue;
    if (rank.lastStreakDay !== yesterday && rank.lastStreakDay !== today) {
      rank.streak = 0;
      savePlayerRank(rank.name || key).catch(e => console.error('streak reset save err:', e.message));
    }
  }
  console.log(`Daily challenges rolled over to ${today}`);
  return true;
}

setInterval(ensureCurrentDay, 60 * 1000);

async function loadDailyProgressFromDB() {
  try {
    const docs = await db.collection('daily_progress').find({}).toArray();
    dailyProgress = {};
    for (const doc of docs) {
      const key = doc.key;
      dailyProgress[key] = { ...doc };
      delete dailyProgress[key]._id;
      delete dailyProgress[key].key;
    }
    console.log(`Loaded ${docs.length} daily progress records`);
  } catch(e) {
    console.error('loadDailyProgressFromDB error:', e.message);
    dailyProgress = {};
  }
}

async function saveDailyProgress(name) {
  if (!db) return;
  const key = name.trim().toLowerCase();
  const rec = dailyProgress[key];
  if (!rec) return;
  try {
    await db.collection('daily_progress').updateOne(
      { key },
      { $set: { key, ...rec } },
      { upsert: true }
    );
  } catch(e) { console.error('saveDailyProgress error:', e.message); }
}

function getPlayerDailyProgress(name) {
  ensureCurrentDay();
  const key = name.trim().toLowerCase();
  const today = getDayKey();
  const challengeSetId=dailyChallenges.map(challenge=>challenge.type).join('|');
  // If record is missing or stale (different day), reset it
  if (!dailyProgress[key] || dailyProgress[key].dayKey !== today || dailyProgress[key].challengeSetId!==challengeSetId) {
    dailyProgress[key] = {
      dayKey: today,
      challengeSetId,
      progress: [0, 0, 0],
      completed: [false, false, false],
      bonusClaimed: false,
      totalPoints: 0,
      name: name.trim(),
      modesPlayed: [],
      mapsPlayed: [],
      challengeOverrides: [],
      rerollUsed: false,
    };
  }
  if (!dailyProgress[key].modesPlayed) dailyProgress[key].modesPlayed = [];
  if (!dailyProgress[key].mapsPlayed) dailyProgress[key].mapsPlayed = [];
  if (!dailyProgress[key].challengeOverrides) dailyProgress[key].challengeOverrides = [];
  if (typeof dailyProgress[key].rerollUsed !== 'boolean') dailyProgress[key].rerollUsed = false;
  return dailyProgress[key];
}

function getPlayerDailyChallenges(rec) {
  return dailyChallenges.map((challenge, index) => rec.challengeOverrides[index] || challenge);
}

function getPlayerWeeklyProgress(name) {
  ensureCurrentWeek();
  const rank = getPlayerRank(name);
  const weekKey = getWeekKey();
  const generated=challengeSystem.generateWeeklyChallenges(weekKey);
  const challengeSetId=generated.map(challenge=>challenge.type).join('|');
  if (!rank.weeklyChallenges || rank.weeklyChallenges.weekKey !== weekKey || rank.weeklyChallenges.challengeSetId!==challengeSetId) {
    rank.weeklyChallenges = {
      weekKey,
      challengeSetId,
      progress:[0,0,0],
      completed:[false,false,false],
      bonusClaimed:false,
      totalPoints:0,
      modesPlayed:[],
      mapsPlayed:[],
    };
  }
  const rec = rank.weeklyChallenges;
  if (!Array.isArray(rec.modesPlayed)) rec.modesPlayed=[];
  if (!Array.isArray(rec.mapsPlayed)) rec.mapsPlayed=[];
  return rec;
}

function getWeeklyChallengePayload(name) {
  const rec=getPlayerWeeklyProgress(name);
  const challenges=challengeSystem.generateWeeklyChallenges(rec.weekKey);
  return {
    weekKey:rec.weekKey,
    challenges:challenges.map((challenge,index)=>({
      ...challenge,
      progress:rec.progress[index]||0,
      completed:!!rec.completed[index],
    })),
    bonusClaimed:rec.bonusClaimed,
    totalPoints:rec.totalPoints,
  };
}

// Returns the combined challenge payload used by the single compact menu panel.
function getDailyPayload(name) {
  const rec = getPlayerDailyProgress(name);
  const rank = getPlayerRank(name);
  ensureCosmeticState(rank);
  return {
    challenges: getPlayerDailyChallenges(rec).map((c, i) => ({
      ...c,
      progress: rec.progress[i] || 0,
      completed: rec.completed[i] || false,
    })),
    bonusClaimed: rec.bonusClaimed,
    totalPoints: rec.totalPoints,
    dayKey: rec.dayKey,
    shards: rank.shards,
    streak: rank.streak,
    rerollAvailable:!rec.rerollUsed,
    weekly:getWeeklyChallengePayload(name),
  };
}

function applyChallengeSet(challenges, rec, stats) {
  const modesBefore=Array.isArray(rec.modesPlayed)?rec.modesPlayed.length:0;
  const mapsBefore=Array.isArray(rec.mapsPlayed)?rec.mapsPlayed.length:0;
  challengeSystem.updateChallengeMemory(rec, stats);
  let shardsEarned=0;
  let anyNew=false;
  let changed=rec.modesPlayed.length!==modesBefore||rec.mapsPlayed.length!==mapsBefore;
  challenges.forEach((challenge,index)=>{
    if (rec.completed[index]) return;
    const previous=rec.progress[index]||0;
    const next=challengeSystem.progressChallenge(
      challenge, previous, stats, rec
    );
    rec.progress[index]=next;
    if (next!==previous) changed=true;
    if (next>=challenge.target) {
      rec.completed[index]=true;
      rec.totalPoints+=challenge.points;
      shardsEarned+=challenge.points;
      anyNew=true;
    }
  });
  return { shardsEarned, anyNew, changed };
}

// Called at the end of each round for a real player.
function updateDailyChallenges(name, stats) {
  if (!name || name.startsWith('__bot__')) return;
  const rec = getPlayerDailyProgress(name);
  const result=applyChallengeSet(getPlayerDailyChallenges(rec),rec,stats);
  let { anyNew, shardsEarned, changed }=result;

  // Bonus: all 3 completed and not yet claimed
  if (!rec.bonusClaimed && rec.completed.every(Boolean)) {
    rec.bonusClaimed = true;
    rec.totalPoints += challengeSystem.DAILY_BONUS_POINTS;
    shardsEarned += challengeSystem.DAILY_BONUS_POINTS;
    anyNew = true;

    // Advance the streak right now, using this record's own dayKey (always
    // correct for "today" from this player's perspective — avoids any race
    // with the once-a-minute rollover poll near midnight UTC).
    const rank = getPlayerRank(name);
    ensureCosmeticState(rank);
    const prevStreakDay = rank.lastStreakDay;
    const expectedPrevDay = addDaysToDayKey(rec.dayKey, -1);
    // Streak continues only if their last credited day was exactly yesterday
    // (relative to this challenge day). Any gap resets to a fresh streak of 1.
    rank.streak = (prevStreakDay === expectedPrevDay) ? rank.streak + 1 : 1;
    rank.lastStreakDay = rec.dayKey;
    const milestoneBonus = streakMilestoneBonus(rank.streak);
    if (milestoneBonus > 0) shardsEarned += milestoneBonus;
    // Note: no explicit save here — awardShards() below persists this same
    // rank record (including the streak fields just set) in one write.
  }

  if (shardsEarned > 0) {
    awardShards(name, shardsEarned);
  }

  if (changed||anyNew) {
    saveDailyProgress(name).catch(e => console.error('updateDailyChallenges save err:', e.message));
  }

  return anyNew;
}

function updateWeeklyChallenges(name, stats) {
  if (!name || name.startsWith('__bot__')) return false;
  const rec=getPlayerWeeklyProgress(name);
  const challenges=challengeSystem.generateWeeklyChallenges(rec.weekKey);
  const result=applyChallengeSet(challenges,rec,stats);
  let { anyNew, shardsEarned, changed }=result;
  if (!rec.bonusClaimed && rec.completed.every(Boolean)) {
    rec.bonusClaimed=true;
    rec.totalPoints+=challengeSystem.WEEKLY_BONUS_POINTS;
    shardsEarned+=challengeSystem.WEEKLY_BONUS_POINTS;
    anyNew=true;
  }
  if (shardsEarned>0) awardShards(name,shardsEarned);
  if (changed||anyNew) savePlayerRank(name).catch(e=>console.error('weekly challenge save err:',e.message));
  return anyNew;
}

function rerollDailyChallenge(name, index) {
  if (!Number.isInteger(index) || index<0 || index>=dailyChallenges.length) {
    return {ok:false,reason:'invalid_slot'};
  }
  const rec=getPlayerDailyProgress(name);
  if (rec.rerollUsed) return {ok:false,reason:'already_used'};
  if (rec.completed[index]) return {ok:false,reason:'already_complete'};
  const current=getPlayerDailyChallenges(rec);
  const replacement=challengeSystem.generateRerolledChallenge(
    rec.dayKey,name,index,current
  );
  if (!replacement) return {ok:false,reason:'no_replacement'};
  rec.challengeOverrides[index]=replacement;
  rec.progress[index]=0;
  rec.completed[index]=false;
  rec.rerollUsed=true;
  saveDailyProgress(name).catch(e=>console.error('challenge reroll save err:',e.message));
  return {ok:true,index};
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
const rooms = { ffa:{}, ranked:{}, tdm:{}, lms:{} };

function utcDayKey(value=Date.now()) {
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '';
  return date.toISOString().slice(0,10);
}

function getLiveRoomSummary() {
  const now=Date.now();
  const rows=[];
  for(const mode of ['ffa','ranked','tdm','lms']){
    const max=mode==='tdm'?TDM_MAX:mode==='ranked'?RANKED_MAX:mode==='lms'?LMS_MAX:FFA_MAX;
    for(const room of Object.values(rooms[mode])){
      const players=Object.values(room.players);
      rows.push({
        id:room.id,
        mode,
        mapId:room.currentMapId,
        roundNumber:room.roundNumber,
        state:room.roundState,
        realPlayers:players.filter(player=>!player.isBot).length,
        bots:players.filter(player=>player.isBot).length,
        maxPlayers:max,
        bullets:room.bullets.length,
        timeLeftMs:Math.max(0,(room.roundState==='playing'?room.roundEndsAt:room.intermissionEndsAt)-now),
      });
    }
  }
  return rows.sort((a,b)=>b.realPlayers-a.realPlayers||a.mode.localeCompare(b.mode));
}

function getAccountAnalytics() {
  const records=Object.values(rankData).filter(Boolean);
  let pinAccounts=0;
  let secureAccounts=0;
  let verifiedEmails=0;
  let paidAccounts=0;
  let totalShards=0;
  for(const rank of records){
    if(rank.pinHash)pinAccounts++;
    if(rank.secureEmail&&rank.passwordHash)secureAccounts++;
    if(rank.secureEmail&&rank.passwordHash&&rank.emailVerifiedAt)verifiedEmails++;
    if(
      (Array.isArray(rank.fulfilledCheckoutIds)&&rank.fulfilledCheckoutIds.length)
      ||Object.values(rank.premiumEntitlements||{}).some(item=>item&&item.status==='active')
    )paidAccounts++;
    totalShards+=Math.max(0,Math.floor(Number(rank.shards)||0));
  }
  return {
    playerRecords:records.length,
    pinAccounts,
    secureAccounts,
    verifiedEmails,
    paidAccounts,
    totalShards,
  };
}

async function getCommerceAnalytics(days,analyticsSummary) {
  const dailyKeys=Array.isArray(analyticsSummary.daily)
    ?analyticsSummary.daily.map(row=>row.day):[];
  const firstDay=dailyKeys[0]||utcDayKey();
  const result={
    source:db?'purchases':'analytics_events',
    byCurrency:[],
    daily:dailyKeys.map(day=>({day,currencies:[]})),
    topProducts:[],
    purchases:0,
    refunds:0,
    receiptEmailsSent:0,
    receiptEmailsPending:0,
  };
  if(!db)return result;

  const start=new Date(`${firstDay}T00:00:00.000Z`);
  const docs=await db.collection('purchases').find({
    createdAt:{$gte:start},
  }).project({
    productKey:1,amountTotal:1,currency:1,status:1,createdAt:1,
    refundedAt:1,receiptEmailSentAt:1,platform:1,
  }).toArray();
  const currencyMap=new Map();
  const dailyMap=new Map(dailyKeys.map(day=>[day,new Map()]));
  const productMap=new Map();
  for(const purchase of docs){
    const amount=Math.max(0,Math.floor(Number(purchase.amountTotal)||0));
    const currency=String(purchase.currency||'unknown').toLowerCase();
    const refunded=purchase.status==='refunded';
    const currencyRow=currencyMap.get(currency)||{
      currency,grossMinor:0,refundedMinor:0,netMinor:0,purchases:0,refunds:0,
    };
    currencyRow.grossMinor+=amount;
    currencyRow.purchases++;
    if(refunded){
      currencyRow.refundedMinor+=amount;
      currencyRow.refunds++;
    }
    currencyRow.netMinor=currencyRow.grossMinor-currencyRow.refundedMinor;
    currencyMap.set(currency,currencyRow);

    const day=utcDayKey(purchase.createdAt);
    if(dailyMap.has(day)){
      const bucket=dailyMap.get(day);
      const dailyCurrency=bucket.get(currency)||{
        currency,grossMinor:0,refundedMinor:0,netMinor:0,purchases:0,refunds:0,
      };
      dailyCurrency.grossMinor+=amount;
      dailyCurrency.purchases++;
      if(refunded){
        dailyCurrency.refundedMinor+=amount;
        dailyCurrency.refunds++;
      }
      dailyCurrency.netMinor=dailyCurrency.grossMinor-dailyCurrency.refundedMinor;
      bucket.set(currency,dailyCurrency);
    }

    const productKey=String(purchase.productKey||'unknown');
    const product=productMap.get(productKey)||{
      productKey,
      name:premiumShop.PRODUCTS[productKey]?.name||productKey,
      purchases:0,
      refunds:0,
    };
    product.purchases++;
    if(refunded)product.refunds++;
    productMap.set(productKey,product);
    result.purchases++;
    if(refunded)result.refunds++;
    if(purchase.receiptEmailSentAt)result.receiptEmailsSent++;
    else result.receiptEmailsPending++;
  }
  result.byCurrency=[...currencyMap.values()].sort((a,b)=>b.netMinor-a.netMinor);
  result.daily=result.daily.map(row=>({
    day:row.day,
    currencies:[...(dailyMap.get(row.day)||new Map()).values()],
  }));
  result.topProducts=[...productMap.values()]
    .sort((a,b)=>b.purchases-a.purchases)
    .slice(0,10);

  // Stripe's durable purchase collection is authoritative. Replace premium
  // event counts so restarts or older analytics deployments do not erase sales.
  const purchaseByDay=new Map(result.daily.map(row=>[
    row.day,row.currencies.reduce((sum,item)=>sum+item.purchases,0),
  ]));
  for(const day of analyticsSummary.daily||[]){
    day.premiumPurchases=purchaseByDay.get(day.day)||0;
    day.purchases=(day.cosmeticPurchases||0)+day.premiumPurchases;
  }
  if(analyticsSummary.totals){
    analyticsSummary.totals.premiumPurchases=result.purchases;
    analyticsSummary.totals.purchases=(analyticsSummary.totals.cosmeticPurchases||0)+result.purchases;
  }
  const cosmeticItems=(analyticsSummary.topShopItems||[])
    .filter(item=>item.category!=='premium');
  analyticsSummary.topShopItems=[
    ...cosmeticItems,
    ...result.topProducts.map(item=>({
      category:'premium',
      id:item.productKey,
      name:item.name,
      count:item.purchases,
      refunds:item.refunds,
    })),
  ].sort((a,b)=>(b.count||0)-(a.count||0)).slice(0,10);
  return result;
}

function initLmsRoundState(room, now) {
  room.lmsGraceEndsAt=now+LMS_GRACE_MS;
  room.finalStandAnnounced=false;
  room.zoneNextDamageAt=now+1000;
  const startRadius=Math.min(WORLD_W,WORLD_H)/2-40;
  room.zone=stormSystem.createStorm({
    now,
    worldW:WORLD_W,
    worldH:WORLD_H,
    startRadius,
    minRadius:LMS_ZONE_MIN_RADIUS,
    timeline:LMS_ZONE_TIMELINE,
    obstacles:currentObs(room),
    playerRadius:PLAYER_R,
  });
}

function createRoom(mode) {
  const id = Math.random().toString(36).substr(2,6).toUpperCase();
  const now=Date.now();
  const room = {
    id, mode,
    players:{}, bullets:[], roster:{},
    bulletId:0, roundState:'playing',
    currentMapId:'arena',
    roundEndsAt:now+ROUND_DURATION_MS,
    roundStartedAt:now,
    intermissionEndsAt:0, roundNumber:1,
    voteOptions:[], votes:{}, roundWinner:null,
    teamKills:{red:0,blue:0},
    leaderboardDirty:true, cachedLeaderboard:[],
    colorIdx:0, playerCountTimer:null,
    zone:null, snapshotSeq:0,
    nextPlayerNetId:1,
    analyticsRoundStarted:false,
  };
  if (mode==='lms') initLmsRoundState(room, now);
  rooms[mode][id] = room;
  return room;
}

function findRoom(mode) {
  const max = mode==='tdm' ? TDM_MAX : mode==='ranked' ? RANKED_MAX : mode==='lms' ? LMS_MAX : FFA_MAX;
  for (const r of Object.values(rooms[mode])) {
    if (Object.keys(r.players).length < max) return r;
  }
  return createRoom(mode);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(v,lo,hi){ return v<lo?lo:v>hi?hi:v; }

function finalizeDeath(room, p, now) {
  p.hp=0; p.alive=false; p.deaths++;
  p.diedThisRound=true; p.noDeathKills=0;
  killStreaks.reset(p);
  roomIO(room).emit('streakState',killStreaks.publicState(p,now));
  if (room.mode==='lms' && now>=room.lmsGraceEndsAt) {
    p.eliminated=true;
    p.eliminatedAt=now;
    p.respawnAt=Infinity;
  } else {
    p.eliminated=false;
    p.eliminatedAt=0;
    p.respawnAt=now+RESPAWN_MS;
  }
}

function updateLmsZone(room, now) {
  stormSystem.updateStorm(room.zone,now);
}

// Info the client needs to draw the current zone, a preview of where it's
// shrinking to next, and a countdown until the current phase ends.
function getLmsZoneInfo(room, now) {
  return stormSystem.getStormInfo(room.zone,now);
}

function healOnKill(shooter) {
  if (!shooter || !shooter.alive) return;
  const before = shooter.hp;
  shooter.hp = Math.min(MAX_HP, shooter.hp + KILL_HEAL);
  if (shooter.hp > before && !shooter.isBot) {
    io.to(shooter.id).emit('killHeal', { hp: shooter.hp, amount: shooter.hp - before });
  }
}

function awardKillStreak(room,shooter,now) {
  const reward=killStreaks.recordKill(shooter,{now,mode:room.mode});
  if(!reward)return;
  const state=killStreaks.publicState(shooter,now);
  roomIO(room).emit('streakState',state);
  if(!shooter.isBot){
    io.to(shooter.id).emit('streakReward',{
      ...state,label:reward.label,durationMs:reward.durationMs,
      lmsAdjusted:reward.lmsAdjusted===true,
    });
  }
}

function overlapsObstacle(x,y,r,obs) {
  for (const o of obs) {
    const nx=Math.max(o.x,Math.min(o.x+o.w,x)), ny=Math.max(o.y,Math.min(o.y+o.h,y));
    const dx=x-nx, dy=y-ny;
    if (dx*dx+dy*dy < r*r) return true;
  }
  return false;
}

function moveWithSlide(px,py,dx,dy,r,obs) {
  const nx=clamp(px+dx,r,WORLD_W-r), ny=clamp(py+dy,r,WORLD_H-r);
  if (!overlapsObstacle(nx,ny,r,obs)) return [nx,ny];
  if (!overlapsObstacle(clamp(px+dx,r,WORLD_W-r),py,r,obs)) return [clamp(px+dx,r,WORLD_W-r),py];
  if (!overlapsObstacle(px,clamp(py+dy,r,WORLD_H-r),r,obs)) return [px,clamp(py+dy,r,WORLD_H-r)];
  return [px,py];
}

function inViewport(px,py,vx,vy,padX=VIEWPORT_PAD,padY=VIEWPORT_PAD){
  return Math.abs(px-vx)<padX&&Math.abs(py-vy)<padY;
}
function currentObs(room){ return MAPS[room.currentMapId].obstacles; }

function allocatePlayerNetId(room) {
  const used=new Set(Object.values(room.players).map(player=>player.netId));
  for(let attempts=0;attempts<65535;attempts++){
    const candidate=room.nextPlayerNetId;
    room.nextPlayerNetId=room.nextPlayerNetId>=65535?1:room.nextPlayerNetId+1;
    if(!used.has(candidate))return candidate;
  }
  return 0;
}

function randomSpawnForMap(mapId,team,zone,occupied=[]) {
  const map=MAPS[mapId], obs=map.obstacles;
  const spawns=(team==='red'&&map.redSpawns)?map.redSpawns:(team==='blue'&&map.blueSpawns)?map.blueSpawns:map.spawns;
  if (zone) {
    return stormSystem.findSafeSpawn({
      spawns,
      zone,
      obstacles:obs,
      worldW:WORLD_W,
      worldH:WORLD_H,
      playerRadius:PLAYER_R,
      avoidPoints:occupied,
    });
  }
  const shuffled=spawns.slice().sort(()=>Math.random()-.5);
  const clearOfPlayers=(x,y,minDistance=PLAYER_R*4)=>occupied.every(other=>{
    if(!other||!Number.isFinite(other.x)||!Number.isFinite(other.y))return true;
    return (x-other.x)**2+(y-other.y)**2>=minDistance**2;
  });
  for (const sp of shuffled) {
    if (!overlapsObstacle(sp.x,sp.y,PLAYER_R+20,obs)&&clearOfPlayers(sp.x,sp.y)) return sp;
  }
  for (let i=0;i<100;i++){
    const x=80+Math.random()*(WORLD_W-160), y=80+Math.random()*(WORLD_H-160);
    if (!overlapsObstacle(x,y,PLAYER_R+30,obs)&&clearOfPlayers(x,y)) return {x,y};
  }
  for (const sp of shuffled) if (!overlapsObstacle(sp.x,sp.y,PLAYER_R+20,obs)) return sp;
  return {x:WORLD_W/2,y:WORLD_H/2};
}

function assignTeam(room) {
  const pList=Object.values(room.players);
  const reds=pList.filter(p=>p.team==='red').length;
  const blues=pList.filter(p=>p.team==='blue').length;
  return reds<=blues?'red':'blue';
}

function makePlayer(id,name,room,isBot=false) {
  const mode=room.mode;
  const team=mode==='tdm'?assignTeam(room):null;
  const color=mode==='tdm'?(team==='red'?TEAM_RED_COLOR:TEAM_BLUE_COLOR):FFA_COLORS[room.colorIdx++%FFA_COLORS.length];
  const occupied=Object.values(room.players).filter(player=>player.alive);
  const sp=randomSpawnForMap(room.currentMapId,team,room.mode==='lms'?room.zone:null,occupied);
  return {
    id, netId:allocatePlayerNetId(room), name, team, color, isBot,
    x:sp.x, y:sp.y, angle:0,
    hp:MAX_HP, alive:true, respawnAt:0,
    kills:0, deaths:0, score:0,
    damageDealt:0, noDeathKills:0, bestNoDeathKills:0, diedThisRound:false,
    killStreak:0,streakEarned:{},streakRewardKey:null,streakRewardEndsAt:0,
    streakShield:0,streakShieldEndsAt:0,
    realKills:0, botKills:0,
    ricochetKillsReal:0, ricochetKillsBot:0, bestRicochetBounces:0,
    realDamageDealt:0, botDamageDealt:0,
    weaponKillsReal:{pistol:0,shotgun:0,smg:0,sniper:0},
    weaponKillsBot:{pistol:0,shotgun:0,smg:0,sniper:0},
    fireCooldown:0, keys:{}, lastInputSeq:-1,
    weapon:DEFAULT_WEAPON,
    eliminated:false, eliminatedAt:0, zoneDamageAccum:0,
    // bot AI state
    botState:'wander',      // 'wander' | 'chase' | 'evade'
    botMoveAngle:Math.random()*Math.PI*2,
    botStuckTicks:0,
    botLastX:sp.x, botLastY:sp.y,
    botWanderTicks:0,
    botNextChatAt:Date.now()+BOT_CHAT_MIN_MS+Math.random()*(BOT_CHAT_MAX_MS-BOT_CHAT_MIN_MS),
    botDifficulty:'easy',
    botAimAngle:Math.random()*Math.PI*2,
    botTargetId:null,
    botTargetLockUntil:0,
    botHesitateUntil:0,
    botFlankSide:Math.random()>0.5?1:-1,
    botChaseBreakAt:0,
    botPersonality:isBot?BOT_PERSONALITIES[Math.floor(Math.random()*BOT_PERSONALITIES.length)]:null,
    botLastHp:MAX_HP,
    botDodgeUntil:0,
    botDodgeAngle:0,
    botCoverPoint:null,
    botPeekAt:0,
    botPeekUntil:0,
    // jitter / stutter
    botJitterAngle:0,
    botJitterUntil:0,
    botStutterUntil:0,
    botStutterDir:1,
    botNextThinkAt:0,
    botCachedSeesTarget:false,
    botTargetLastId:null,
    botTargetLastX:0,
    botTargetLastY:0,
    botTargetLastAt:0,
    botTargetVx:0,
    botTargetVy:0,
    botReactionUntil:0,
    // reactive chat throttle
    botLastReactChatAt:0,
  };
}

function getLeaderboard(room) {
  if (!room.leaderboardDirty) return room.cachedLeaderboard;
  room.cachedLeaderboard = Object.values(room.players)
    .sort((a,b)=>b.score-a.score).slice(0,LEADERBOARD_SIZE)
    .map(p=>({id:p.id,name:p.name,score:p.score,kills:p.kills,color:p.color,team:p.team,isBot:p.isBot}));
  room.leaderboardDirty=false;
  return room.cachedLeaderboard;
}

function roomIO(room){ return io.to(`room:${room.id}`); }

function socketStreamContext(room,sid,sock) {
  const me=room.players[sid];
  if(!me||me.isBot)return null;
  const isSpectator=!!me.eliminated;
  const anchor=isSpectator
    ?room.players[me.spectateTargetId]||Object.values(room.players).find(player=>player.alive&&!player.eliminated)||me
    :me;
  const width=Number(sock.data.viewportWidth)||1280;
  const height=Number(sock.data.viewportHeight)||720;
  return {
    me,
    anchor,
    isSpectator,
    padX:clamp(Math.ceil(width/2)+VIEWPORT_MARGIN,520,1200),
    padY:clamp(Math.ceil(height/2)+VIEWPORT_MARGIN,520,1200),
  };
}

function emitV3BulletPacket(room,event,bullets) {
  if(!Array.isArray(bullets)||!bullets.length)return;
  const socketIds=io.sockets.adapter.rooms.get(`room:${room.id}`);
  if(!socketIds)return;
  for(const sid of socketIds){
    const sock=io.sockets.sockets.get(sid);
    if(!sock||sock.data.compactStateVersion!==3||sock.data.networkHidden)continue;
    const stream=socketStreamContext(room,sid,sock);
    if(!stream)continue;
    const visible=bullets.filter(bullet=>inViewport(
      bullet.x,bullet.y,stream.anchor.x,stream.anchor.y,stream.padX,stream.padY
    ));
    if(!visible.length)continue;
    const packet=networkCodec.encodeBulletPacket(room.snapshotSeq,visible,room.players);
    runtimeMetrics.recordRealtime(room.mode,event,packet);
    // Spawn is a one-time lifecycle event. Keep it reliable so a brief flush
    // cannot make a projectile appear late; periodic binary corrections remain
    // disposable.
    sock.emit(event,packet);
  }
}

function emitV3BulletGone(room,ids) {
  if(!Array.isArray(ids)||!ids.length)return;
  const socketIds=io.sockets.adapter.rooms.get(`room:${room.id}`);
  if(!socketIds)return;
  const payload=ids.slice(0,256);
  for(const sid of socketIds){
    const sock=io.sockets.sockets.get(sid);
    if(!sock||sock.data.compactStateVersion!==3)continue;
    runtimeMetrics.recordRealtime(room.mode,'bulletGone3',payload);
    sock.emit('bulletGone3',payload);
  }
}

function emitBulletBounces(room,bounces) {
  if(!Array.isArray(bounces)||!bounces.length)return;
  const socketIds=io.sockets.adapter.rooms.get(`room:${room.id}`);
  if(!socketIds)return;
  for(const sid of socketIds){
    const sock=io.sockets.sockets.get(sid);
    if(!sock||sock.data.networkHidden)continue;
    const stream=socketStreamContext(room,sid,sock);
    if(!stream)continue;
    const visible=bounces.filter(bounce=>inViewport(
      bounce[1],bounce[2],stream.anchor.x,stream.anchor.y,stream.padX,stream.padY
    ));
    if(!visible.length)continue;
    runtimeMetrics.recordRealtime(room.mode,'bulletBounce',visible);
    // This is visual immediacy, not authoritative state. A missed volatile
    // event is corrected by the next projectile snapshot; it must never queue
    // ahead of movement or ping traffic on a slow connection.
    sock.volatile.emit('bulletBounce',visible);
  }
}

function schedulePlayerCount(room) {
  if (room.playerCountTimer) return;
  room.playerCountTimer=setTimeout(()=>{
    // Only count real players in the public count
    const real=Object.values(room.players).filter(p=>!p.isBot).length;
    roomIO(room).emit('playerCount', real);
    room.playerCountTimer=null;
  },200);
}

// ── Bot management ────────────────────────────────────────────────────────────
let botIdCounter = 0;
const usedBotNames = new Set();

function getRandomBotName() {
  // Shuffle unused names, fall back to numbered if exhausted
  const unused = BOT_NAMES.filter(n => !usedBotNames.has(n));
  if (unused.length > 0) {
    const name = unused[Math.floor(Math.random()*unused.length)];
    usedBotNames.add(name);
    return name;
  }
  let fallback;
  do fallback=`kael${100+Math.floor(Math.random()*900)}`;
  while(usedBotNames.has(fallback));
  usedBotNames.add(fallback);
  return fallback;
}

function releaseUsedBotName(name) {
  usedBotNames.delete(name);
}

function realPlayerCount(room) {
  return Object.values(room.players).filter(p=>!p.isBot).length;
}

function botCount(room) {
  return Object.values(room.players).filter(p=>p.isBot).length;
}

function botDifficultyForRoom(room) {
  const real = realPlayerCount(room);
  if (real <= 2) return 'easy';
  if (real <= 5) return 'medium';
  return 'hard';
}

function spawnBot(room) {
  const id = `__bot__${botIdCounter++}`;
  const name = getRandomBotName();
  const bot = makePlayer(id, name, room, true);
  bot.botDifficulty = botDifficultyForRoom(room);
  bot.weapon=pickBotWeapon(bot);
  room.players[id] = bot;
  room.roster[id] = { netId:bot.netId, name:bot.name, color:bot.color, team:bot.team, cosmetics:null };
  // Notify all real players that a new "player" joined
  roomIO(room).emit('rosterAdd', { id, netId:bot.netId, name:bot.name, color:bot.color, team:bot.team, cosmetics:null });
  room.leaderboardDirty = true;
}

function removeBot(room) {
  // Remove most recently added bot
  const bots = Object.values(room.players).filter(p=>p.isBot);
  if (bots.length === 0) return;
  const bot = bots[bots.length-1];
  releaseUsedBotName(bot.name);
  delete room.players[bot.id];
  delete room.roster[bot.id];
  roomIO(room).emit('playerLeft', bot.id);
  roomIO(room).emit('rosterRemove', bot.id);
  room.leaderboardDirty = true;
}

function removeAllBots(room) {
  const bots = Object.values(room.players).filter(p=>p.isBot);
  for (const bot of bots) {
    releaseUsedBotName(bot.name);
    delete room.players[bot.id];
    delete room.roster[bot.id];
    roomIO(room).emit('playerLeft', bot.id);
    roomIO(room).emit('rosterRemove', bot.id);
  }
  if (bots.length > 0) room.leaderboardDirty = true;
}

function syncBotPopulation(room) {
  if (!['ffa','ranked','lms'].includes(room.mode)||room.roundState!=='playing') return;
  const real=realPlayerCount(room);
  const desired=real>=BOT_MAX_REAL?0:Math.max(0,BOT_TARGET_TOTAL-real);
  while(botCount(room)<desired) spawnBot(room);
  while(botCount(room)>desired) removeBot(room);
  const difficulty=botDifficultyForRoom(room);
  for(const player of Object.values(room.players)){
    if(player.isBot) player.botDifficulty=difficulty;
  }
}

// Periodic repair in case a room changes outside the normal join/leave flow.
function balanceBots() {
  for (const mode of ['ffa','ranked','lms']) {
    for (const room of Object.values(rooms[mode])) {
      syncBotPopulation(room);
    }
  }
}

// ── Bot AI ────────────────────────────────────────────────────────────────────
const BOT_SPEED_EASY   = PLAYER_SPEED * 0.42;
const BOT_SPEED_MEDIUM = PLAYER_SPEED * 0.55;
const BOT_SPEED_HARD   = PLAYER_SPEED * 0.65;
const BOT_IDEAL_DIST   = PLAYER_R * 7;
const BOT_AIM_TURN     = { easy:0.06, medium:0.10, hard:0.14 };
const BOT_THINK_MS     = { easy:110, medium:80, hard:60 };
const BOT_WEAPON_RANGE = { pistol:380, shotgun:190, smg:315, sniper:560 };
const BOT_PERSONALITIES = ['aggressive','camper','rusher','tactician'];
const BOT_PERSONALITY = {
  aggressive:{ speed:1.05, chase:1.12, fire:1.1, ideal:6.5, evade:0.28, weapons:['pistol','smg'] },
  camper:    { speed:0.9, chase:0.72, fire:1.0, ideal:14, evade:0.48, weapons:['sniper','pistol'] },
  rusher:    { speed:1.1, chase:1.18, fire:0.9, ideal:4.2, evade:0.22, weapons:['shotgun','smg'] },
  tactician: { speed:1.0, chase:0.95, fire:1.0, ideal:10, evade:0.38, weapons:['pistol','sniper','smg'] },
};

function botTraits(bot){ return BOT_PERSONALITY[bot.botPersonality]||BOT_PERSONALITY.aggressive; }

function pickBotWeapon(bot) {
  const choices=botTraits(bot).weapons||[DEFAULT_WEAPON];
  return choices[Math.floor(Math.random()*choices.length)]||DEFAULT_WEAPON;
}

function botSpeed(bot) {
  if (bot.botDifficulty === 'hard')   return BOT_SPEED_HARD;
  if (bot.botDifficulty === 'medium') return BOT_SPEED_MEDIUM;
  return BOT_SPEED_EASY;
}

function angleDiff(a,b){
  let d=b-a;
  while(d>Math.PI)d-=Math.PI*2;
  while(d<-Math.PI)d+=Math.PI*2;
  return d;
}

function lerpAngle(from,to,maxStep){
  return from+clamp(angleDiff(from,to),-maxStep,maxStep);
}

function hasLineOfSight(ax,ay,bx,by,obs){
  const dist=Math.hypot(bx-ax,by-ay);
  const steps=Math.max(2,Math.ceil(dist/24));
  for(let i=1;i<steps;i++){
    const t=i/steps,x=ax+(bx-ax)*t,y=ay+(by-ay)*t;
    if(overlapsObstacle(x,y,PLAYER_R*0.5,obs)) return false;
  }
  return true;
}

function findCoverPoint(bot,threat,obs){
  if(!threat) return null;
  let best=null,bestScore=Infinity;
  for(const o of obs){
    const pts=[
      {x:o.x-PLAYER_R*3,y:o.y+o.h*0.5},
      {x:o.x+o.w+PLAYER_R*3,y:o.y+o.h*0.5},
      {x:o.x+o.w*0.5,y:o.y-PLAYER_R*3},
      {x:o.x+o.w*0.5,y:o.y+o.h+PLAYER_R*3},
    ];
    for(const c of pts){
      if(c.x<PLAYER_R||c.y<PLAYER_R||c.x>WORLD_W-PLAYER_R||c.y>WORLD_H-PLAYER_R) continue;
      if(overlapsObstacle(c.x,c.y,PLAYER_R,obs)) continue;
      if(hasLineOfSight(threat.x,threat.y,c.x,c.y,obs)) continue;
      const dBot=Math.hypot(c.x-bot.x,c.y-bot.y);
      const canPeek=hasLineOfSight(c.x,c.y,threat.x,threat.y,obs);
      const score=dBot-(canPeek?70:0);
      if(score<bestScore){bestScore=score;best=c;}
    }
  }
  return best;
}

function steerBotAroundObstacle(bot,moveX,moveY,obs) {
  const lookAhead=PLAYER_R*3.2;
  if (!overlapsObstacle(bot.x+moveX*lookAhead,bot.y+moveY*lookAhead,PLAYER_R,obs)) {
    return {x:moveX,y:moveY};
  }
  const side=bot.botFlankSide||1;
  const left={x:-moveY,y:moveX};
  const right={x:moveY,y:-moveX};
  const leftFree=!overlapsObstacle(bot.x+left.x*lookAhead,bot.y+left.y*lookAhead,PLAYER_R,obs);
  const rightFree=!overlapsObstacle(bot.x+right.x*lookAhead,bot.y+right.y*lookAhead,PLAYER_R,obs);
  if (leftFree&&rightFree) return side>0?left:right;
  if (leftFree) return left;
  if (rightFree) return right;
  return {x:-moveX,y:-moveY};
}

function getBotSafeZoneTarget(room,now) {
  const info=stormSystem.getStormInfo(room.zone,now);
  if(!info)return null;
  return {
    cx:info.nextCx,
    cy:info.nextCy,
    radius:Math.max(PLAYER_R*3,info.nextR-PLAYER_R*4),
  };
}

function botCanSee(bot,target,obs){
  const dx=target.x-bot.x, dy=target.y-bot.y;
  const dist=Math.sqrt(dx*dx+dy*dy);
  if(dist<PLAYER_R*8) return hasLineOfSight(bot.x,bot.y,target.x,target.y,obs);
  const look=bot.botState==='chase'||bot.botState==='peek'?bot.botMoveAngle:bot.botAimAngle;
  const toTarget=Math.atan2(dy,dx);
  return Math.abs(angleDiff(look,toTarget))<BOT_AWARE_FOV/2
    &&hasLineOfSight(bot.x,bot.y,target.x,target.y,obs);
}

function pickBotTarget(bot,room,pList){
  const now=Date.now();
  const locked=bot.botTargetId&&room.players[bot.botTargetId];
  if(locked&&locked.alive){
    if(room.mode==='tdm'&&locked.team===bot.team){bot.botTargetId=null;}
    else{
      const d=Math.hypot(locked.x-bot.x,locked.y-bot.y);
      if(d<BOT_CHASE_RANGE*1.35&&now<bot.botTargetLockUntil) return locked;
    }
  }
  let best=null,bestScore=Infinity;
  for(const p of pList){
    if(p.id===bot.id||!p.alive) continue;
    if(room.mode==='tdm'&&p.team===bot.team) continue;
    const dx=p.x-bot.x, dy=p.y-bot.y;
    const dist=Math.sqrt(dx*dx+dy*dy);
    if(dist>BOT_CHASE_RANGE) continue;
    if(dist>BOT_CHASE_RANGE*0.55&&Math.random()<0.2) continue;
    // Prefer low-hp targets: a target at 25hp is worth ~40% closer in scoring
    const hpMod = 0.6 + 0.4 * (p.hp / MAX_HP); // 0.6 (low hp) to 1.0 (full hp)
    const attackers=pList.filter(other=>
      other.isBot&&other.id!==bot.id&&other.alive&&other.botTargetId===p.id
    ).length;
    // Spread bots across available opponents instead of dog-piling one player.
    const weighted = dist * hpMod * (p.isBot ? 1.35 : 1.0) * (1+attackers*0.4);
    if(weighted<bestScore){bestScore=weighted;best=p;}
  }
  if(best){
    bot.botTargetId=best.id;
    bot.botTargetLockUntil=now+BOT_TARGET_LOCK_MS+Math.random()*1200;
    if(Math.random()<0.35) bot.botFlankSide*=-1;
  } else bot.botTargetId=null;
  return best;
}

function resetBotAI(bot){
  bot.botMoveAngle=Math.random()*Math.PI*2;
  bot.botAimAngle=bot.botMoveAngle;
  bot.botState='wander';
  bot.botTargetId=null;
  bot.botTargetLockUntil=0;
  bot.botHesitateUntil=0;
  bot.botChaseBreakAt=0;
  bot.botFlankSide=Math.random()>0.5?1:-1;
  bot.botLastHp=bot.hp;
  bot.botDodgeUntil=0;
  bot.botCoverPoint=null;
  bot.botPeekAt=0;
  bot.botPeekUntil=0;
  bot.botJitterAngle=0;
  bot.botJitterUntil=0;
  bot.botStutterUntil=0;
  bot.botStutterDir=1;
  bot.botFakeoutUntil=0;
  bot.botFakeoutNextAt=0;
  bot.botFakeoutDir=1;
  bot.botNextThinkAt=0;
  bot.botCachedSeesTarget=false;
  bot.botTargetLastId=null;
  bot.botTargetLastAt=0;
  bot.botTargetVx=0;
  bot.botTargetVy=0;
  bot.botReactionUntil=0;
}

function tickBot(bot, room) {
  if (!bot.alive || room.roundState !== 'playing') return;

  const obs  = currentObs(room);
  const pList = Object.values(room.players);
  const now  = Date.now();

  const traits=botTraits(bot);
  const idealDist=PLAYER_R*traits.ideal;
  const chaseRange=BOT_CHASE_RANGE*traits.chase;
  const evadeThreshold=MAX_HP*traits.evade;

  // Expensive perception (target search + line of sight) runs at 9–16 Hz,
  // while cached decisions still produce smooth 60 Hz movement.
  const shouldThink=now>=bot.botNextThinkAt;
  let target=bot.botTargetId?room.players[bot.botTargetId]:null;
  if (!target||!target.alive) target=null;
  let seesTarget=!!bot.botCachedSeesTarget;
  if (shouldThink) {
    const previousTargetId=bot.botTargetId;
    target=pickBotTarget(bot,room,pList);
    seesTarget=target?botCanSee(bot,target,obs):false;
    bot.botCachedSeesTarget=seesTarget;
    bot.botNextThinkAt=now+(BOT_THINK_MS[bot.botDifficulty]||BOT_THINK_MS.easy);
    if (target&&previousTargetId!==target.id) {
      bot.botReactionUntil=now+180+Math.random()*260;
      bot.botTargetLastId=null;
    }
    if (target) {
      if (bot.botTargetLastId===target.id&&bot.botTargetLastAt>0) {
        const ticks=Math.max(1,(now-bot.botTargetLastAt)/PHYSICS_MS);
        bot.botTargetVx=clamp((target.x-bot.botTargetLastX)/ticks,-PLAYER_SPEED*1.3,PLAYER_SPEED*1.3);
        bot.botTargetVy=clamp((target.y-bot.botTargetLastY)/ticks,-PLAYER_SPEED*1.3,PLAYER_SPEED*1.3);
      }
      bot.botTargetLastId=target.id;
      bot.botTargetLastX=target.x;
      bot.botTargetLastY=target.y;
      bot.botTargetLastAt=now;
    }
  }
  const realDist=target?Math.hypot(target.x-bot.x,target.y-bot.y):Infinity;

  if(bot.hp<bot.botLastHp){
    bot.botDodgeUntil=now+280+Math.random()*320;
    bot.botDodgeAngle=bot.botMoveAngle+(Math.random()>0.5?1:-1)*Math.PI*0.55;
    if(bot.hp<MAX_HP*0.55||bot.botPersonality==='camper'){
      bot.botState='cover';
      bot.botCoverPoint=findCoverPoint(bot,target,obs);
      bot.botPeekAt=now+500+Math.random()*900;
    }
  }
  bot.botLastHp=bot.hp;

  // ── Separation: push away from nearby bots so they don't pile up ──────────
  let sepX = 0, sepY = 0;
  for (const p of pList) {
    if (!p.isBot || p.id === bot.id || !p.alive) continue;
    const dx = bot.x - p.x, dy = bot.y - p.y;
    const dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < PLAYER_R * 4 && dist > 0) {
      // Push away proportional to how close they are
      sepX += (dx / dist) * (PLAYER_R * 4 - dist) * 0.3;
      sepY += (dy / dist) * (PLAYER_R * 4 - dist) * 0.3;
    }
  }

  // ── State machine ─────────────────────────────────────────────────────────
  if (shouldThink) {
    if(bot.botState==='wander'){
      if(bot.botPersonality==='camper'&&target&&realDist<chaseRange*0.9){
        bot.botState='cover'; bot.botCoverPoint=findCoverPoint(bot,target,obs); bot.botPeekAt=now+700+Math.random()*800;
      } else if(target&&seesTarget&&realDist<chaseRange*0.85){
        bot.botState='chase'; bot.botChaseBreakAt=0;
      }
      if(bot.hp<evadeThreshold) bot.botState='evade';
    } else if(bot.botState==='chase'){
      if(!target||realDist>chaseRange*1.25) bot.botState='wander';
      if(bot.hp<evadeThreshold) bot.botState='evade';
      if(bot.botPersonality==='camper'&&bot.hp<MAX_HP*0.7){ bot.botState='cover'; bot.botCoverPoint=findCoverPoint(bot,target,obs); }
      if(now>=bot.botChaseBreakAt){ bot.botState='wander'; bot.botChaseBreakAt=now+2200+Math.random()*2800; }
      else if(bot.botChaseBreakAt===0) bot.botChaseBreakAt=now+1800+Math.random()*2200;
    } else if(bot.botState==='cover'){
      if(!target||realDist>chaseRange*1.3){ bot.botState='wander'; bot.botCoverPoint=null; }
      else if(now>=bot.botPeekAt&&seesTarget){ bot.botState='peek'; bot.botPeekUntil=now+320+Math.random()*280; }
      else if(bot.hp>MAX_HP*0.8&&bot.botPersonality!=='camper'&&Math.random()<0.08) bot.botState='chase';
    } else if(bot.botState==='peek'){
      if(now>=bot.botPeekUntil){ bot.botState='cover'; bot.botPeekAt=now+900+Math.random()*1100; }
      if(bot.hp<evadeThreshold) bot.botState='evade';
    } else if(bot.botState==='evade'){
      if(bot.hp>MAX_HP*0.58){
        bot.botState=(target&&seesTarget&&realDist<chaseRange*0.75&&bot.botPersonality!=='camper')?'chase':'wander';
        bot.botChaseBreakAt=0;
      }
    }
  }

  // ── Calculate desired movement direction ──────────────────────────────────
  let moveX = 0, moveY = 0;
  const hesitating=now<bot.botHesitateUntil;
  const dodging=now<bot.botDodgeUntil;

  if(dodging){
    moveX=Math.cos(bot.botDodgeAngle);
    moveY=Math.sin(bot.botDodgeAngle);
    bot.botMoveAngle=bot.botDodgeAngle;
  } else if(!hesitating&&bot.botState==='cover'){
    if(bot.botCoverPoint){
      const dx=bot.botCoverPoint.x-bot.x, dy=bot.botCoverPoint.y-bot.y;
      const d=Math.hypot(dx,dy)||1;
      if(d>36){ moveX=dx/d; moveY=dy/d; bot.botMoveAngle=Math.atan2(moveY,moveX); }
    }
  } else if(!hesitating&&bot.botState==='peek'&&target){
    const toX=target.x-bot.x, toY=target.y-bot.y;
    const len=Math.hypot(toX,toY)||1;
    moveX=toX/len*0.65; moveY=toY/len*0.65;
    bot.botMoveAngle=Math.atan2(moveY,moveX);
  } else if(!hesitating&&bot.botState==='chase'&&target){
    const toX=target.x-bot.x, toY=target.y-bot.y;
    const len=Math.sqrt(toX*toX+toY*toY)||1;
    const directX=toX/len, directY=toY/len;
    const flankX=Math.cos(Math.atan2(toY,toX)+bot.botFlankSide*0.65);
    const flankY=Math.sin(Math.atan2(toY,toX)+bot.botFlankSide*0.65);

    if(realDist>idealDist+20){
      const rush=bot.botPersonality==='rusher'?0.65:0.45;
      moveX=directX*rush+flankX*(1-rush);
      moveY=directY*rush+flankY*(1-rush);
    } else if(realDist<idealDist-15){
      moveX=-directX*0.8;
      moveY=-directY*0.8;
    } else {
      bot.botWanderTicks++;
      const strafeDir=Math.sin(bot.botWanderTicks*0.035)>0?1:-1;
      moveX=(-toY/len)*strafeDir*0.85+flankX*0.15;
      moveY=(toX/len)*strafeDir*0.85+flankY*0.15;
    }
    bot.botMoveAngle=Math.atan2(moveY,moveX);

  } else if(!hesitating&&bot.botState==='evade'&&target){
    const awayX=bot.x-target.x, awayY=bot.y-target.y;
    const len=Math.sqrt(awayX*awayX+awayY*awayY)||1;
    const toCX=WORLD_W/2-bot.x, toCY=WORLD_H/2-bot.y;
    const cLen=Math.sqrt(toCX*toCX+toCY*toCY)||1;
    moveX=(awayX/len)*0.8+(toCX/cLen)*0.2;
    moveY=(awayY/len)*0.8+(toCY/cLen)*0.2;
    const mLen=Math.sqrt(moveX*moveX+moveY*moveY)||1;
    moveX/=mLen; moveY/=mLen;
    bot.botMoveAngle=Math.atan2(moveY,moveX);

  } else if(!hesitating){
    // Wander — smooth direction changes so motion looks natural
    bot.botWanderTicks++;
    if (bot.botWanderTicks > BOT_WANDER_CHANGE) {
      // Pick a new direction biased toward map center if near edges
      const edgeBias = 0.3;
      const toCX = WORLD_W/2 - bot.x, toCY = WORLD_H/2 - bot.y;
      const cLen = Math.sqrt(toCX*toCX + toCY*toCY) || 1;
      const rAngle = Math.random() * Math.PI * 2;
      const biasX  = (toCX/cLen) * edgeBias + Math.cos(rAngle) * (1-edgeBias);
      const biasY  = (toCY/cLen) * edgeBias + Math.sin(rAngle) * (1-edgeBias);
      bot.botMoveAngle = Math.atan2(biasY, biasX);
      bot.botWanderTicks = 0;
    }
    moveX = Math.cos(bot.botMoveAngle);
    moveY = Math.sin(bot.botMoveAngle);
  }

  // Add separation force
  moveX += sepX * 0.08;
  moveY += sepY * 0.08;

  // ── Movement jitter — micro-wobble so bots never path perfectly straight ───
  // Only applied during chase/evade so wander stays smooth
  if (bot.botState === 'chase' || bot.botState === 'evade') {
    if (now >= bot.botJitterUntil) {
      // New jitter burst every 300-700ms
      bot.botJitterAngle = (Math.random() - 0.5) * 0.55;
      bot.botJitterUntil = now + 300 + Math.random() * 400;
    }
    const jx = Math.cos(bot.botMoveAngle + bot.botJitterAngle);
    const jy = Math.sin(bot.botMoveAngle + bot.botJitterAngle);
    moveX = moveX * 0.82 + jx * 0.18;
    moveY = moveY * 0.82 + jy * 0.18;
  }

  // ── Stutter-step — briefly reverse while shooting, makes bots harder to hit ─
  // Only at medium/hard difficulty, only when actively shooting at someone
  if ((bot.botDifficulty === 'medium' || bot.botDifficulty === 'hard') &&
      bot.botState === 'chase' && target && now < bot.botDodgeUntil === false) {
    if (now >= bot.botStutterUntil) {
      // New stutter decision every 900-1800ms
      bot.botStutterDir = Math.random() < 0.4 ? -1 : 1; // 40% chance to step back
      bot.botStutterUntil = now + 900 + Math.random() * 900;
    }
    if (bot.botStutterDir === -1) {
      // Brief back-pedal: push move vector slightly away from target
      if (target) {
        const dx = bot.x - target.x, dy = bot.y - target.y;
        const dl = Math.sqrt(dx*dx+dy*dy) || 1;
        moveX = moveX * 0.5 + (dx/dl) * 0.5;
        moveY = moveY * 0.5 + (dy/dl) * 0.5;
      }
    }
  }

  // ── Fake-out — occasionally stop mid-approach then dart a different way ─────
  // Feels like hesitation/mind-game; only aggressive/rusher personalities
  if ((bot.botPersonality === 'aggressive' || bot.botPersonality === 'rusher') &&
      bot.botState === 'chase' && target && realDist < BOT_CHASE_RANGE * 0.6) {
    if (!bot.botFakeoutUntil) bot.botFakeoutUntil = 0;
    if (!bot.botFakeoutNextAt) bot.botFakeoutNextAt = now + 4000 + Math.random() * 6000;
    if (now >= bot.botFakeoutNextAt && now > bot.botFakeoutUntil) {
      // Start a fake: stop and veer sideways for 200-400ms
      bot.botFakeoutUntil = now + 200 + Math.random() * 200;
      bot.botFakeoutNextAt = now + 3500 + Math.random() * 5000;
      bot.botFakeoutDir = Math.random() < 0.5 ? 1 : -1;
    }
    if (now < bot.botFakeoutUntil && target) {
      // Sidestep perpendicular to target
      const toX = target.x - bot.x, toY = target.y - bot.y;
      const tl = Math.sqrt(toX*toX+toY*toY) || 1;
      moveX = (-toY/tl) * bot.botFakeoutDir;
      moveY = (toX/tl) * bot.botFakeoutDir;
    }
  }

  // ── Last Man Standing: storm awareness overrides everything else ───────────
  // Bots pre-position for the next safe radius instead of waiting to take
  // damage, but keep enough margin that they do not crowd the exact centre.
  if (room.mode==='lms' && room.zone) {
    const safeTarget=getBotSafeZoneTarget(room,now);
    const zdx=bot.x-safeTarget.cx, zdy=bot.y-safeTarget.cy;
    if (Math.sqrt(zdx*zdx+zdy*zdy) > safeTarget.radius) {
      const toCenter=Math.atan2(safeTarget.cy-bot.y,safeTarget.cx-bot.x);
      moveX=Math.cos(toCenter); moveY=Math.sin(toCenter);
      bot.botMoveAngle=toCenter;
    }
  }

  const steered=steerBotAroundObstacle(bot,moveX,moveY,obs);
  moveX=steered.x;
  moveY=steered.y;

  // Normalise
  const mLen = Math.sqrt(moveX*moveX + moveY*moveY) || 1;
  moveX /= mLen; moveY /= mLen;

  // ── Apply movement ────────────────────────────────────────────────────────
  const spd=botSpeed(bot)*traits.speed*(hesitating?0.22:dodging?1.15:1)
    *killStreaks.movementMultiplier(bot,now);
  const prevX = bot.x, prevY = bot.y;
  [bot.x, bot.y] = moveWithSlide(bot.x, bot.y, moveX*spd, moveY*spd, PLAYER_R, obs);

  // ── Stuck detection — much more aggressive escape ─────────────────────────
  const moved = Math.abs(bot.x-prevX) + Math.abs(bot.y-prevY);
  if (moved < 0.5) { // higher threshold — catches near-stuck too
    bot.botStuckTicks++;
    if (bot.botStuckTicks > BOT_STUCK_TICKS) {
      // Large random turn — 90° to 270° so we always clear corners
      bot.botMoveAngle += Math.PI * (0.5 + Math.random());
      bot.botStuckTicks = 0;
      bot.botWanderTicks = BOT_WANDER_CHANGE; // force new wander direction next tick
      bot.botState = 'wander'; // reset to wander so we don't chase straight back into wall
    }
  } else {
    bot.botStuckTicks = Math.max(0, bot.botStuckTicks - 2); // decay when moving fine
  }

  // ── World boundary avoidance — turn inward when near edges ───────────────
  const margin = 120;
  if (bot.x < margin || bot.x > WORLD_W-margin || bot.y < margin || bot.y > WORLD_H-margin) {
    // Point toward centre
    bot.botMoveAngle = Math.atan2(WORLD_H/2 - bot.y, WORLD_W/2 - bot.x);
    bot.botWanderTicks = 0;
  }

  // ── Aim & shoot (smoothed aim — no instant lock-on) ───────────────────────
  const turnRate=BOT_AIM_TURN[bot.botDifficulty]||BOT_AIM_TURN.easy;
  const botWeapon=WEAPONS[bot.weapon]||WEAPONS[DEFAULT_WEAPON];
  const shootRange=BOT_WEAPON_RANGE[botWeapon.id]||BOT_SHOOT_RANGE;
  if(target&&seesTarget&&realDist<shootRange){
    let fireChance=0, lead=false;

    if(bot.botDifficulty==='easy'){
      fireChance=0.22;
    } else if(bot.botDifficulty==='medium'){
      fireChance=0.38;
      lead=Math.random()<0.45;
    } else {
      fireChance=0.52;
      lead=Math.random()<0.65;
    }

    let aimX=target.x, aimY=target.y;
    if(lead&&bot.botTargetLastId===target.id){
      const travelTicks=realDist/botWeapon.bulletSpeed;
      const leadStrength=bot.botDifficulty==='hard'?0.8:0.55;
      aimX+=bot.botTargetVx*travelTicks*leadStrength;
      aimY+=bot.botTargetVy*travelTicks*leadStrength;
    }

    // Keep the turret visibly tracking its intended target. Difficulty comes
    // from reaction/turn speed and the allowed aim error, not a new random
    // turret direction every physics tick.
    const desiredAim=Math.atan2(aimY-bot.y,aimX-bot.x);
    bot.botAimAngle=lerpAngle(bot.botAimAngle,desiredAim,turnRate);
    bot.angle=bot.botAimAngle;

    const aimErr=Math.abs(angleDiff(bot.botAimAngle,Math.atan2(target.y-bot.y,target.x-bot.x)));
    const maxFireError=bot.botDifficulty==='hard'?0.10:bot.botDifficulty==='medium'?0.15:0.22;
    fireChance*=traits.fire;
    if(bot.botState==='peek') fireChance*=1.25;
    if(now>=bot.botReactionUntil&&bot.fireCooldown<=0&&aimErr<maxFireError&&Math.random()<fireChance&&room.bullets.length<MAX_BULLETS-botWeapon.pellets){
      if(Math.random()<0.08) bot.botHesitateUntil=now+120+Math.random()*280;
      else{
        const pellets=Math.max(1,botWeapon.pellets);
        const spawned=[];
        for (let pellet=0;pellet<pellets;pellet++) {
          const a=pellets>1
            ?bot.angle+(pellet-(pellets-1)/2)*(botWeapon.spread/Math.max(1,pellets-1))*2
            :bot.angle+(Math.random()-0.5)*botWeapon.spread;
          const bullet={
            id:room.bulletId++,
            x:bot.x+Math.cos(a)*BULLET_MUZZLE_OFFSET,
            y:bot.y+Math.sin(a)*BULLET_MUZZLE_OFFSET,
            vx:Math.cos(a)*botWeapon.bulletSpeed,
            vy:Math.sin(a)*botWeapon.bulletSpeed,
            owner:bot.id, ownerTeam:bot.team, ownerColor:bot.color,
            life:botWeapon.bulletLife,dmg:botWeapon.damage,r:botWeapon.bulletR,wpn:botWeapon.id,
            bouncesLeft:ricochet.ricochetsForWeapon(botWeapon.id),bounceCount:0,
          };
          room.bullets.push(bullet);
          spawned.push(bullet);
        }
        emitV3BulletPacket(room,'bulletSpawn3',spawned);
        bot.fireCooldown=Math.max(1,Math.ceil(
          botWeapon.fireCooldown*killStreaks.cooldownMultiplier(bot,now)
        ))+Math.floor(Math.random()*8)+3;
      }
    }
  } else {
    bot.botAimAngle=lerpAngle(bot.botAimAngle,bot.botMoveAngle,turnRate*0.8);
    bot.angle=bot.botAimAngle;
  }

  if (bot.fireCooldown > 0) bot.fireCooldown--;

  // ── Occasional random chat ───────────────────────────────────────────────
  if (now >= bot.botNextChatAt) {
    const pool = BOT_CHAT.random;
    const msg = pool[Math.floor(Math.random()*pool.length)];
    roomIO(room).emit('chat', { id:bot.id, name:bot.name, color:bot.color, msg, teamOnly:false, team:bot.team });
    bot.botNextChatAt = now + BOT_CHAT_MIN_MS + Math.random()*(BOT_CHAT_MAX_MS-BOT_CHAT_MIN_MS);
  }
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
  let best=room.voteOptions[0]||'arena', bestCount=-1;
  for (const [id,c] of Object.entries(counts)) if(c>bestCount){bestCount=c;best=id;}
  return {winner:best,counts};
}

function startIntermission(room) {
  if (!room || room.roundState !== 'playing') return;
  room.roundState='intermission';
  room.votes={}; room.voteOptions=pickVoteOptions(room);
  room.intermissionEndsAt=Date.now()+INTERMISSION_MS;

  analytics.logEvent('match_end',{
    mode:room.mode, mapId:room.currentMapId, roomId:room.id,
    durationMs:room.roundStartedAt?Date.now()-room.roundStartedAt:null,
    playerCount:realPlayerCount(room),
    ricochetKills:Object.values(room.players).reduce((sum,player)=>sum+(player.ricochetKillsReal||0)+(player.ricochetKillsBot||0),0),
    bestRicochetBounces:Object.values(room.players).reduce((best,player)=>Math.max(best,player.bestRicochetBounces||0),0),
  });
  room.analyticsRoundStarted=false;

  // Record real player stats to weekly leaderboard (bots excluded)
  for (const p of Object.values(room.players)) {
    if (!p.isBot && p.kills > 0) recordWeeklyKill(p.name, p.color, p.kills, p.score);
  }
  saveWeekly();
  roomIO(room).emit('weeklyLeaderboard', getWeeklyLB());

  // Determine round winner first (TDM needs this for both the banner and daily challenges)
  const pList=Object.values(room.players);
  room.roundWinner=null;
  let tdmWinTeam=null;
  if (room.mode==='tdm') {
    tdmWinTeam=room.teamKills.red>=room.teamKills.blue?'red':'blue';
    const tied=room.teamKills.red===room.teamKills.blue;
    room.roundWinner={type:'team',team:tdmWinTeam,color:tdmWinTeam==='red'?TEAM_RED_COLOR:TEAM_BLUE_COLOR,redKills:room.teamKills.red,blueKills:room.teamKills.blue,tied};
    if (tied) tdmWinTeam=null; // a tie counts as nobody's win for challenge purposes
  } else if (room.mode==='lms') {
    // Last player standing wins, regardless of kill count. If the round ended
    // by timeout with more than one still alive, or everyone died at once,
    // fall back to most kills.
    const aliveP=pList.filter(p=>p.alive);
    if (aliveP.length===1) {
      const w=aliveP[0];
      room.roundWinner={type:'player',id:w.id,name:w.name,color:w.color,kills:w.kills,score:w.score};
    } else {
      const real=pList.filter(p=>!p.isBot);
      const pool=real.length>0?real:pList;
      if (pool.length>0) {
        const top=pool.reduce((a,b)=>b.kills>a.kills?b:a,pool[0]);
        room.roundWinner={type:'player',id:top.id,name:top.name,color:top.color,kills:top.kills,score:top.score};
      }
    }
  } else {
    // Only real players can "win" the round announcement
    const real=pList.filter(p=>!p.isBot);
    const pool=real.length>0?real:pList;
    if (pool.length>0) {
      const top=pool.reduce((a,b)=>b.kills>a.kills?b:a,pool[0]);
      room.roundWinner={type:'player',id:top.id,name:top.name,color:top.color,kills:top.kills,score:top.score};
    }
  }

  // Update challenge progress for each real player. Bot eliminations count at
  // 25% so practice still gives a little progress without becoming a fast farm.
  const realPlayers = Object.values(room.players).filter(p => !p.isBot);
  const recentAccountKeys=realPlayers.map(player=>player.accountKey).filter(Boolean);
  if(recentAccountKeys.length>1){
    socialSystem.recordRecentPlayers(recentAccountKeys,room.mode)
      .catch(error=>console.error('recent players save err:',error.message));
  }
  const sorted = realPlayers.slice().sort((a,b) => {
    if (room.mode==='lms') {
      if (a.alive!==b.alive) return a.alive?-1:1;
      const eliminatedOrder=(b.eliminatedAt||0)-(a.eliminatedAt||0);
      if (eliminatedOrder) return eliminatedOrder;
    }
    return b.kills-a.kills||b.score-a.score;
  });
  const count = sorted.length;
  for (const p of realPlayers) {
    const placementIdx = sorted.indexOf(p);
    const competitiveRound=count>=2;
    const won = room.mode==='tdm'
      ? competitiveRound && tdmWinTeam!=null && p.team===tdmWinTeam
      : room.mode==='lms'
        ? competitiveRound && room.roundWinner?.id===p.id
        : competitiveRound && placementIdx===0;
    const challengeKills=(p.realKills||0)+(p.botKills||0)*0.25;
    const challengeDamage=(p.realDamageDealt||0)+(p.botDamageDealt||0)*0.25;
    const challengeRicochetKills=(p.ricochetKillsReal||0)+(p.ricochetKillsBot||0)*0.25;
    const challengeWeaponKills={};
    for (const weaponId of Object.keys(WEAPONS)) {
      challengeWeaponKills[weaponId]=(p.weaponKillsReal?.[weaponId]||0)+(p.weaponKillsBot?.[weaponId]||0)*0.25;
    }
    const challengeStats = {
      kills: p.kills,
      score: p.score,
      challengeKills,
      challengeDamage,
      challengeScore:challengeKills*100,
      challengeWeaponKills,
      challengeRicochetKills,
      won,
      competitiveRound,
      placement:placementIdx+1,
      isRanked: room.mode === 'ranked',
      isTdm: room.mode === 'tdm',
      isFfa: room.mode === 'ffa',
      isLms: room.mode === 'lms',
      mode: room.mode,
      mapId:room.currentMapId,
      damageDealt: p.damageDealt || 0,
      survivedRound: !p.diedThisRound,
      noDeathKills: p.bestNoDeathKills || p.noDeathKills || 0,
      deaths: p.deaths || 0,
    };
    updateDailyChallenges(p.name, challengeStats);
    updateWeeklyChallenges(p.name, challengeStats);
    io.to(p.id).emit('dailyProgress', getDailyPayload(p.name));
  }


  // Record rank changes (after roundWinner is set so TDM knows the winner)
  recordRankResult(room);

  // Remove bots during intermission, respawn fresh ones when round starts
  removeAllBots(room);

  roomIO(room).emit('intermission',{
    roundWinner:room.roundWinner,
    voteOptions:room.voteOptions.map(id=>({id,...MAPS[id],obstacles:undefined})),
    endsAt:room.intermissionEndsAt, roundNumber:room.roundNumber, mode:room.mode,
  });
}

function startRound(room,mapId) {
  if (!MAPS[mapId]) mapId='arena';
  room.currentMapId=mapId; room.roundNumber++;
  room.roundState='playing'; room.roundEndsAt=Date.now()+ROUND_DURATION_MS;
  room.roundStartedAt=Date.now();
  room.bullets.length=0; room.teamKills={red:0,blue:0};

  if (room.mode==='lms') {
    initLmsRoundState(room, room.roundStartedAt);
  } else {
    room.zone=null;
  }

  analytics.logEvent('match_start',{
    mode:room.mode, mapId, roomId:room.id,
    playerCount:realPlayerCount(room),
  });
  room.analyticsRoundStarted=true;

  const occupiedSpawns=[];
  for (const p of Object.values(room.players)) {
    if (p.isBot) continue; // bots are removed during intermission, re-spawned below
    p.kills=0; p.deaths=0; p.score=0; p.hp=MAX_HP; p.alive=true; p.fireCooldown=0;
    killStreaks.reset(p);
    p.damageDealt=0; p.noDeathKills=0; p.bestNoDeathKills=0; p.diedThisRound=false;
    p.keys={};
    p.realKills=0; p.botKills=0; p.realDamageDealt=0; p.botDamageDealt=0;
    p.ricochetKillsReal=0; p.ricochetKillsBot=0; p.bestRicochetBounces=0;
    p.weaponKillsReal={pistol:0,shotgun:0,smg:0,sniper:0};
    p.weaponKillsBot={pistol:0,shotgun:0,smg:0,sniper:0};
    p.eliminated=false; p.eliminatedAt=0; p.zoneDamageAccum=0;
    const sp=randomSpawnForMap(mapId,p.team,room.zone,occupiedSpawns);
    p.x=sp.x; p.y=sp.y;
    occupiedSpawns.push(p);
  }
  room.leaderboardDirty=true;

  // Build the complete roster before clients receive the new-round state.
  syncBotPopulation(room);

  roomIO(room).emit('newRound',{
    mapId, mapName:MAPS[mapId].name, mapEmoji:MAPS[mapId].emoji,
    mapColor:MAPS[mapId].color, obstacles:MAPS[mapId].obstacles,
    roundNumber:room.roundNumber, endsAt:room.roundEndsAt,
    mode:room.mode, teamKills:room.teamKills,
  });
  // Give every real client its authoritative spawn immediately rather than
  // showing the old-round location until the next disposable snapshot arrives.
  for (const p of Object.values(room.players)) {
    if (!p.isBot) io.to(p.id).emit('roundSpawn',{x:p.x,y:p.y});
  }
  roomIO(room).emit('leaderboard',getLeaderboard(room));

}

// Restore an existing browser session during the Socket.IO handshake. The
// socket still needs a short-lived login code after a fresh HTTP login because
// some cross-origin Socket.IO deployments cannot forward the new cookie until
// the next reconnect.
io.use(async(socket,next)=>{
  try{
    const token=secureAccounts.parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE];
    socket.data.accountSession=token?await accountSessionFromToken(token):null;
    next();
  }catch(error){
    console.error('socket session lookup err:',error.message);
    socket.data.accountSession=null;
    next();
  }
});

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  let myRoom=null;
  let authedNameKey=socket.data.accountSession?.nameKey||null;
  let lastAuthAttempt=0;
  let socialActionWindowStarted=Date.now();
  let socialActionCount=0;
  let lastKnownName=null;
  let lastKnownMode=null;
  let activeSession=null;
  let lastClientAnalyticsAt=0;
  socket.data.compactStateVersion=0;
  socket.data.viewportWidth=1280;
  socket.data.viewportHeight=720;
  socket.data.networkHidden=false;
  socket.data.knownBulletIds=new Map();
  socket.data.v4KnownBulletIds=new Set();
  socket.data.lastRoomMetaAt=0;
  socket.data.lastRoomMetaSignature='';
  socket.data.gameMode=null;
  socket.data.clientPlatform='web';
  if(authedNameKey)registerAccountSocket(socket,authedNameKey);
  if(authedNameKey)setImmediate(()=>{
    if(socket.connected&&authedNameKey)emitSocialStateAndFriends(authedNameKey);
  });

  function socialRateAllowed(){
    const now=Date.now();
    if(now-socialActionWindowStarted>=60000){
      socialActionWindowStarted=now;
      socialActionCount=0;
    }
    socialActionCount++;
    return socialActionCount<=30;
  }

  function socialKey(){
    return authedNameKey&&rankData[authedNameKey]?authedNameKey:null;
  }

  function currentPartyMember(payload={}){
    const key=socialKey();
    const id=socialMemberId(socket,key);
    const existing=socialSystem.getPartyByMember(id)?.members.find(member=>member.id===id);
    const name=key
      ?socialName(key)
      :cleanPlayerName(payload.name)||cleanPlayerName(existing?.name)||cleanPlayerName(lastKnownName);
    if(!name)return null;
    return {
      id,
      socketId:socket.id,
      accountKey:key,
      name,
      platform:cleanClientPlatform(payload.platform||existing?.platform||socket.data.clientPlatform),
    };
  }

  function leaveCurrentParty(reason='left'){
    const key=socialKey();
    const memberId=socialMemberId(socket,key);
    const former=socialSystem.getPartyByMember(memberId);
    const remaining=socialSystem.leaveParty(memberId);
    emitPartyCleared(socket,reason);
    if(remaining)emitParty(remaining);
    else if(former)partyInviteGrants.delete(former.code);
    if(former){
      for(const member of former.members){
        if(member.accountKey)emitSocialStateAndFriends(member.accountKey);
      }
    }
    if(key)emitSocialStateAndFriends(key);
  }

  function resolveRequestName(clientName) {
    if (myRoom) {
      const player=myRoom.players[socket.id];
      if (player&&!player.isBot) return player.name;
    }
    return cleanPlayerName(clientName)||null;
  }

  function protectedNameFailure(name) {
    const account=getAccountState(name);
    if ((account.state==='locked'||account.state==='secure_locked')
        && authedNameKey!==playerNameKey(name)) {
      return { reason:account.state, retryAt:account.retryAt };
    }
    if ((account.state==='protected'||account.state==='secured')
        && authedNameKey!==playerNameKey(name)) {
      return { reason:'auth_required' };
    }
    return null;
  }

  function startActiveSession(player,room,platform,accountType) {
    activeSession={
      name:player.name,
      mode:room.mode,
      platform,
      accountType,
      startedAt:Date.now(),
    };
    analytics.logEvent('session_start',{
      name:player.name,
      mode:room.mode,
      platform,
      accountType,
      socketId:socket.id,
    });
  }

  function endActiveSession(reason) {
    if(!activeSession)return;
    const ended=activeSession;
    activeSession=null;
    analytics.logEvent('session_end',{
      name:ended.name,
      mode:ended.mode,
      platform:ended.platform,
      accountType:ended.accountType,
      durationMs:Math.max(0,Date.now()-ended.startedAt),
      reason,
    });
  }

  function leaveCurrentRoom(reason='leave') {
    if (!myRoom) return {ok:true,left:false};
    const room=myRoom;
    const player=room.players[socket.id]||null;
    endActiveSession(reason);
    myRoom=null;
    delete room.players[socket.id];
    delete room.roster[socket.id];
    delete room.votes[socket.id];
    socket.leave(`room:${room.id}`);
    roomIO(room).emit('playerLeft',socket.id);
    roomIO(room).emit('rosterRemove',socket.id);
    schedulePlayerCount(room);
    if (player) analytics.logEvent('leave',{
      name:player.name,mode:room.mode,socketId:socket.id,reason,
    });
    lastKnownName=null;
    lastKnownMode=null;
    socket.data.gameMode=null;
    if (realPlayerCount(room)===0) {
      if (room.playerCountTimer) {
        clearTimeout(room.playerCountTimer);
        room.playerCountTimer=null;
      }
      removeAllBots(room);
      delete rooms[room.mode][room.id];
    }else{
      syncBotPopulation(room);
    }
    if(authedNameKey)emitSocialStateAndFriends(authedNameKey);
    return {ok:true,left:!!player};
  }

  socket.data.accountDeletionCleanup=name=>{
    leaveCurrentRoom('account_deleted');
    leaveCurrentParty('account_deleted');
    unregisterAccountSocket(socket);
    authedNameKey=null;
    socket.data.accountSession=null;
    socket.emit('socialState',{signedIn:false});
    socket.emit('accountDeleted',{name});
  };

  socket.on('leaveGame',(payload,ack)=>{
    asObject(payload);
    const result=leaveCurrentRoom('client_leave');
    if (typeof ack==='function') ack(result);
  });

  socket.on('getSocial',()=>{
    const key=socialKey();
    socket.emit('socialState',key?socialSnapshot(key):{signedIn:false});
    socket.emit('recentPlayers',key?recentPlayersSnapshot(key):{signedIn:false,players:[]});
    const memberId=socialMemberId(socket,key);
    const party=socialSystem.getPartyByMember(memberId);
    socket.emit('partyState',partyPublicPayload(party,memberId));
  });

  socket.on('socialAction',async(payload,ack)=>{
    const key=socialKey();
    const data=asObject(payload);
    if(!key){
      const result={ok:false,reason:'account_required'};
      socket.emit('socialResult',result);
      if(typeof ack==='function')ack(result);
      return;
    }
    if(!socialRateAllowed()){
      const result={ok:false,reason:'rate_limited'};
      socket.emit('socialResult',result);
      if(typeof ack==='function')ack(result);
      return;
    }
    const targetKey=playerNameKey(data.name);
    let result={ok:false,reason:'invalid_action'};
    try{
      if(data.type==='request')result=await socialSystem.sendRequest(key,targetKey);
      else if(data.type==='accept')result=await socialSystem.acceptRequest(key,targetKey);
      else if(data.type==='decline')result=await socialSystem.declineRequest(key,targetKey);
      else if(data.type==='cancel')result=await socialSystem.cancelRequest(key,targetKey);
      else if(data.type==='remove')result=await socialSystem.removeFriend(key,targetKey);
      else if(data.type==='block')result=await socialSystem.block(key,targetKey);
      else if(data.type==='unblock')result=await socialSystem.unblock(key,targetKey);
      else if(data.type==='settings')result=await socialSystem.updateSettings(key,{
        appearOffline:data.appearOffline,
        joinPolicy:data.joinPolicy,
      });
    }catch(error){
      console.error('social action err:',error.message);
      result={ok:false,reason:'server_error'};
    }
    socket.emit('socialResult',result);
    if(typeof ack==='function')ack(result);
    emitSocialStateAndFriends(key);
    if(targetKey)emitSocialStateAndFriends(targetKey);
    socket.emit('recentPlayers',recentPlayersSnapshot(key));
  });

  socket.on('partyCreate',(payload,ack)=>{
    const member=currentPartyMember(asObject(payload));
    const former=member&&socialSystem.getPartyByMember(member.id);
    const result=member?socialSystem.createParty(member):{ok:false,reason:'name_required'};
    if(result.ok){
      if(former&&!former.members.length)partyInviteGrants.delete(former.code);
      if(former&&former.code!==result.party.code)emitParty(former);
      emitParty(result.party);
      if(member.accountKey)emitSocialStateAndFriends(member.accountKey);
    }
    if(typeof ack==='function')ack({ok:result.ok,reason:result.reason,code:result.party?.code});
  });

  socket.on('partyJoin',(payload,ack)=>{
    const data=asObject(payload);
    const member=currentPartyMember(data);
    const former=member&&socialSystem.getPartyByMember(member.id);
    const code=String(data.code||'').trim().toUpperCase();
    const grants=partyInviteGrants.get(code);
    const invitedUntil=member?.accountKey&&grants?.get(member.accountKey);
    const invited=Number(invitedUntil)>Date.now();
    const result=member
      ?socialSystem.joinParty(member,code,{invited})
      :{ok:false,reason:'name_required'};
    if(result.ok){
      if(former&&!former.members.length)partyInviteGrants.delete(former.code);
      if(invited)grants.delete(member.accountKey);
      if(former&&former.code!==result.party.code)emitParty(former);
      emitParty(result.party);
      for(const item of result.party.members){
        if(item.accountKey)emitSocialStateAndFriends(item.accountKey);
      }
    }
    if(typeof ack==='function')ack({ok:result.ok,reason:result.reason,code:result.party?.code});
  });

  socket.on('partyLeave',(payload,ack)=>{
    asObject(payload);
    leaveCurrentParty('left');
    if(typeof ack==='function')ack({ok:true});
  });

  socket.on('partySetOpen',(payload,ack)=>{
    const member=currentPartyMember(asObject(payload));
    const result=member
      ?socialSystem.setOpen(member.id,asObject(payload).open===true)
      :{ok:false,reason:'name_required'};
    if(result.ok){
      emitParty(result.party);
      for(const item of result.party.members){
        if(item.accountKey)emitSocialStateAndFriends(item.accountKey);
      }
    }
    if(typeof ack==='function')ack({ok:result.ok,reason:result.reason});
  });

  socket.on('partyKick',(payload,ack)=>{
    const member=currentPartyMember(asObject(payload));
    const party=member&&socialSystem.getPartyByMember(member.id);
    const target=party?.members.find(item=>item.socketId===asObject(payload).memberId);
    const result=member&&target
      ?socialSystem.kick(member.id,target.id)
      :{ok:false,reason:'not_in_party'};
    if(result.ok){
      const targetSocket=io.sockets.sockets.get(target.socketId);
      if(targetSocket)emitPartyCleared(targetSocket,'removed');
      emitParty(result.party);
      if(target.accountKey)emitSocialStateAndFriends(target.accountKey);
      for(const item of result.party.members){
        if(item.accountKey)emitSocialStateAndFriends(item.accountKey);
      }
    }
    if(typeof ack==='function')ack({ok:result.ok,reason:result.reason});
  });

  socket.on('partyPromote',(payload,ack)=>{
    const member=currentPartyMember(asObject(payload));
    const party=member&&socialSystem.getPartyByMember(member.id);
    const target=party?.members.find(item=>item.socketId===asObject(payload).memberId);
    const result=member&&target
      ?socialSystem.promote(member.id,target.id)
      :{ok:false,reason:'not_in_party'};
    if(result.ok)emitParty(result.party);
    if(typeof ack==='function')ack({ok:result.ok,reason:result.reason});
  });

  socket.on('partyInvite',(payload,ack)=>{
    if(!socialRateAllowed()){
      if(typeof ack==='function')ack({ok:false,reason:'rate_limited'});
      return;
    }
    const key=socialKey();
    const targetKey=playerNameKey(asObject(payload).name);
    const member=currentPartyMember(asObject(payload));
    const party=member&&socialSystem.getPartyByMember(member.id);
    const social=key&&ensureSocial(rankData[key]);
    if(!key||!party||!social?.friends.includes(targetKey)){
      if(typeof ack==='function')ack({ok:false,reason:'friend_required'});
      return;
    }
    const grants=partyInviteGrants.get(party.code)||new Map();
    grants.set(targetKey,Date.now()+60000);
    partyInviteGrants.set(party.code,grants);
    for(const target of accountSocketList(targetKey)){
      target.emit('partyInvite',{
        from:socialName(key),
        code:party.code,
        expiresAt:Date.now()+60000,
      });
    }
    if(typeof ack==='function')ack({ok:true});
  });

  socket.on('partyLaunch',(payload,ack)=>{
    const member=currentPartyMember(asObject(payload));
    const party=member&&socialSystem.getPartyByMember(member.id);
    if(!party||party.leaderId!==member.id){
      if(typeof ack==='function')ack({ok:false,reason:'not_leader'});
      return;
    }
    const mode=PUBLIC_GAME_MODES.has(asObject(payload).mode)?asObject(payload).mode:'ffa';
    const room=findPartyRoom(party,mode);
    party.mode=mode;
    party.gameRoomId=room.id;
    emitParty(party);
    for(const item of party.members){
      const target=io.sockets.sockets.get(item.socketId);
      if(target)target.emit('partyLaunch',{mode,code:party.code});
    }
    if(typeof ack==='function')ack({ok:true,mode});
  });

  // The menu leaderboard is available before a player joins a room.
  socket.emit('weeklyLeaderboard', getWeeklyLB());
  socket.on('getWeeklyLeaderboard', () => {
    socket.emit('weeklyLeaderboard', getWeeklyLB());
  });

  socket.on('ping_check',payload=>{
    const ping=typeof payload==='number'?{ts:payload}:asObject(payload);
    if(typeof ping.ts!=='number'||!Number.isFinite(ping.ts))return;
    const metrics=asObject(ping.metrics);
    if(myRoom&&Object.keys(metrics).length){
      runtimeMetrics.addPerformanceSample({
        ping:metrics.ping,
        fps:metrics.fps,
        platform:cleanClientPlatform(metrics.platform),
      });
    }
    socket.emit('pong_check',ping.ts);
  });

  // Protocol negotiation keeps rolling deployments safe: older cached clients
  // remain on v3/v2/legacy while current clients opt into the queue-safe v4
  // packet that combines movement and projectile changes.
  socket.on('clientCapabilities',(payload,ack)=>{
    const compactState=asObject(payload).compactState;
    socket.data.compactStateVersion=compactState===4?4:compactState===3?3:compactState===2?2:0;
    socket.data.knownBulletIds=new Map();
    socket.data.v4KnownBulletIds=new Set();
    socket.data.lastRoomMetaAt=0;
    socket.data.lastRoomMetaSignature='';
    if(typeof ack==='function')ack({compactState:socket.data.compactStateVersion});
  });

  socket.on('networkVisibility',payload=>{
    socket.data.networkHidden=asObject(payload).hidden===true;
    // A newly visible tab receives complete bullet metadata on its next
    // snapshot, so extrapolation resumes cleanly after the inactive pause.
    if (!socket.data.networkHidden) {
      socket.data.knownBulletIds=new Map();
      socket.data.v4KnownBulletIds=new Set();
    }
  });

  socket.on('clientViewport',payload=>{
    const viewport=cleanViewport(payload);
    socket.data.viewportWidth=viewport.width;
    socket.data.viewportHeight=viewport.height;
  });

  socket.on('performanceSample',payload=>{
    if(!myRoom)return;
    const sample=asObject(payload);
    runtimeMetrics.addPerformanceSample({
      ping:sample.ping,
      fps:sample.fps,
      platform:cleanClientPlatform(sample.platform),
    });
  });

  socket.on('clientAnalytics',payload=>{
    const now=Date.now();
    if(now-lastClientAnalyticsAt<500)return;
    lastClientAnalyticsAt=now;
    const data=asObject(payload);
    if(!['shop_view','checkout_cancel'].includes(data.type))return;
    const name=resolveRequestName(data.name);
    analytics.logEvent(data.type,{
      name:name||undefined,
      mode:myRoom?.mode||undefined,
      platform:cleanClientPlatform(data.platform),
    });
  });

  socket.on('getDailyChallenges', (payload) => {
    // Works two ways: from inside a room (uses the joined player's name), or from
    // the main menu before joining anything (client sends the typed name instead —
    // the shop/daily buttons are reachable pre-game, so this must not require a room).
    const name=resolveRequestName(asObject(payload).name);
    if (!name) return;
    socket.emit('dailyProgress', getDailyPayload(name));
  });

  socket.on('rerollDailyChallenge', (payload) => {
    const {index,name:clientName}=asObject(payload);
    const name=resolveRequestName(clientName);
    if (!name) {
      socket.emit('challengeRerollResult',{ok:false,reason:'name_required'});
      return;
    }
    const denied=protectedNameFailure(name);
    if (denied) {
      socket.emit('challengeRerollResult',{ok:false,...denied});
      return;
    }
    const result=rerollDailyChallenge(name,index);
    socket.emit('challengeRerollResult',result);
    if (result.ok) socket.emit('dailyProgress',getDailyPayload(name));
  });

  // ── Cosmetics shop ──────────────────────────────────────────────────────────
  socket.on('getShop', (payload) => {
    const name=resolveRequestName(asObject(payload).name);
    if (!name) return;
    const session=authedNameKey===playerNameKey(name)?socket.data.accountSession:null;
    socket.emit('shopState', getShopPayload(name,session));
  });

  socket.on('buyCosmetic', (payload) => {
    const {category,id,name:clientName}=asObject(payload);
    const name=resolveRequestName(clientName);
    if (!name) return;
    const denied=protectedNameFailure(name);
    if (denied) {
      socket.emit('shopResult',{ok:false,...denied});
      return;
    }
    const result = buyCosmetic(name, category, id);
    if (result.ok) {
      const session=authedNameKey===playerNameKey(name)?socket.data.accountSession:null;
      result.shop=getShopPayload(name,session);
    }
    socket.emit('shopResult', result);
  });

  socket.on('equipCosmetic', (payload) => {
    const {category,id,name:clientName}=asObject(payload);
    const name=resolveRequestName(clientName);
    if (!name) return;
    const denied=protectedNameFailure(name);
    if (denied) {
      socket.emit('shopResult',{ok:false,...denied});
      return;
    }
    const result = equipCosmetic(name, category, id);
    if (result.ok) {
      const session=authedNameKey===playerNameKey(name)?socket.data.accountSession:null;
      result.shop=getShopPayload(name,session);
    }
    socket.emit('shopResult', result);
    if (result.ok && myRoom) {
      // Let everyone in the room see the new trail/name-color/kill-fx immediately,
      // not just the player who changed it. Only relevant if already in a room.
      const p = myRoom.players[socket.id];
      if (p) roomIO(myRoom).emit('cosmeticsUpdate', { id: socket.id, cosmetics: getPublicCosmetics(name) });
    }
  });

  socket.on('getSessionAccount',()=>{
    socket.emit('sessionAccount',sessionAccountSummary(socket.data.accountSession));
  });

  socket.on('logoutAccount',(payload,ack)=>{
    asObject(payload);
    const leaveResult=leaveCurrentRoom('account_logout');
    leaveCurrentParty('account_logout');
    unregisterAccountSocket(socket);
    authedNameKey=null;
    socket.data.accountSession=null;
    socket.emit('sessionAccount',{signedIn:false});
    socket.emit('socialState',{signedIn:false});
    if (typeof ack==='function') ack({ok:true,left:leaveResult.left});
  });

  // Step 1: client asks whether a name needs a PIN, has one already, or is locked out
  socket.on('checkAccount', (payload) => {
    const {name,requestId}=asObject(payload);
    const cleanName=cleanPlayerName(name);
    const responseId=Number.isSafeInteger(requestId)?requestId:undefined;
    if (!cleanName) { socket.emit('accountState', { state:'invalid',requestId:responseId }); return; }
    const result = getAccountState(cleanName);
    if (authedNameKey===playerNameKey(cleanName)) {
      socket.emit('accountState', {
        state:'session',
        level:socket.data.accountSession?.level||'pin',
        name:cleanName,
        requestId:responseId,
      });
    }else{
      socket.emit('accountState', {...result,name:cleanName,requestId:responseId});
    }
  });

  // A fresh HTTP login returns a one-use, one-minute code. Exchanging it here
  // proves the browser session to this already-connected socket without ever
  // sending a PIN or password through Socket.IO.
  socket.on('resumeSecureSession',(payload)=>{
    const {name,code}=asObject(payload);
    const cleanName=cleanPlayerName(name);
    const record=cleanName&&typeof code==='string'?consumeSocketLoginCode(code,cleanName):null;
    const rank=record?findRankByAccountId(record.accountId):null;
    if (!record||!rank) {
      socket.emit('resumeAuthResult',{ok:false,reason:'invalid_session'});
      return;
    }
    const joinedPlayer=myRoom&&myRoom.players[socket.id];
    if (joinedPlayer&&playerNameKey(joinedPlayer.name)!==record.nameKey) {
      leaveCurrentRoom('account_switch');
    }
    if(authedNameKey&&authedNameKey!==record.nameKey)leaveCurrentParty('account_switch');
    unregisterAccountSocket(socket);
    authedNameKey=record.nameKey;
    socket.data.accountSession={...record,rank};
    registerAccountSocket(socket,authedNameKey);
    socket.emit('resumeAuthResult',{ok:true,name:rank.name,level:record.level});
    emitSocialStateAndFriends(authedNameKey);
  });

  // Step 2: client creates a new PIN (first time using this name) or verifies an existing one
  socket.on('authAccount', (payload) => {
    const {name,pin,mode:authMode}=asObject(payload);
    const cleanName = cleanPlayerName(name);
    if (!cleanName) { socket.emit('authResult', { ok:false, reason:'invalid_name' }); return; }
    if (!isValidPin(pin)) { socket.emit('authResult', { ok:false, reason:'invalid_pin' }); return; }

    const now = Date.now();
    if (now - lastAuthAttempt < ATTEMPT_MIN_GAP_MS) return; // hard rate limit per-socket
    lastAuthAttempt = now;

    const state = getAccountState(cleanName);

    if (state.state==='secured'||state.state==='secure_locked') {
      socket.emit('authResult',{ok:false,reason:'password_required',retryAt:state.retryAt});
      return;
    }

    if (state.state === 'locked') {
      socket.emit('authResult', { ok:false, reason:'locked', retryAt:state.retryAt });
      return;
    }

    if (authMode === 'create') {
      // Only allow creating if no account exists yet (avoid overwriting someone's PIN)
      const recheck = getAccountState(cleanName);
      if (recheck.state === 'protected') {
        socket.emit('authResult', { ok:false, reason:'already_exists' });
        return;
      }
      createAccount(cleanName, pin);
      const joinedPlayer=myRoom&&myRoom.players[socket.id];
      if (joinedPlayer&&playerNameKey(joinedPlayer.name)!==playerNameKey(cleanName)) {
        leaveCurrentRoom('account_switch');
      }
      if(authedNameKey&&authedNameKey!==playerNameKey(cleanName))leaveCurrentParty('account_switch');
      unregisterAccountSocket(socket);
      authedNameKey = playerNameKey(cleanName);
      registerAccountSocket(socket,authedNameKey);
      socket.emit('authResult', { ok:true, name:cleanName });
      emitSocialStateAndFriends(authedNameKey);
      return;
    }

    // authMode === 'login'
    const result = verifyPin(cleanName, pin);
    if (result.ok) {
      const joinedPlayer=myRoom&&myRoom.players[socket.id];
      if (joinedPlayer&&playerNameKey(joinedPlayer.name)!==playerNameKey(cleanName)) {
        leaveCurrentRoom('account_switch');
      }
      if(authedNameKey&&authedNameKey!==playerNameKey(cleanName))leaveCurrentParty('account_switch');
      unregisterAccountSocket(socket);
      authedNameKey = playerNameKey(cleanName);
      registerAccountSocket(socket,authedNameKey);
      socket.emit('authResult', { ok:true, name:cleanName });
      emitSocialStateAndFriends(authedNameKey);
    } else {
      socket.emit('authResult', { ok:false, reason:result.reason, attemptsLeft:result.attemptsLeft, retryAt:result.retryAt });
    }
  });

  socket.on('join',(payload)=>{
    const {
      name,mode:wantMode,weapon:wantWeapon,platform:rawPlatform,viewport:rawViewport,
    }=asObject(payload);
    if (myRoom) {
      socket.emit('joinDenied', { reason:'already_joined' });
      return;
    }
    const mode=PUBLIC_GAME_MODES.has(wantMode)?wantMode:'ffa';
    const safe=cleanPlayerName(name);
    if (!safe) {
      socket.emit('joinDenied', { reason:'invalid_name' });
      return;
    }
    const chosenWeapon=isValidWeapon(wantWeapon)?wantWeapon:DEFAULT_WEAPON;
    const platform=cleanClientPlatform(rawPlatform);
    socket.data.clientPlatform=platform;
    const viewport=cleanViewport(rawViewport);
    socket.data.viewportWidth=viewport.width;
    socket.data.viewportHeight=viewport.height;

    // Security gate: if this name has a PIN-protected account, this socket must have
    // already authenticated as that exact name via authAccount before joining.
    const acctState = getAccountState(safe);
    if ((acctState.state === 'protected'||acctState.state === 'secured')
        && authedNameKey !== playerNameKey(safe)) {
      socket.emit('joinDenied', { reason:'auth_required' });
      return;
    }
    if ((acctState.state === 'locked'||acctState.state === 'secure_locked')
        && authedNameKey !== playerNameKey(safe)) {
      socket.emit('joinDenied', { reason:acctState.state, retryAt: acctState.retryAt });
      return;
    }

    lastKnownName=safe; lastKnownMode=mode;
    const accountType=acctState.state==='secured'?'secure'
      :acctState.state==='protected'?'pin':'guest';
    analytics.logEvent('join',{
      name:safe,mode,socketId:socket.id,weapon:chosenWeapon,platform,accountType,
    });

    const partyMemberId=socialMemberId(socket,authedNameKey);
    const party=socialSystem.getPartyByMember(partyMemberId);
    let room;
    if(party){
      const priorRoomId=party.gameRoomId;
      const priorMode=party.mode;
      room=findPartyRoom(party,mode);
      const shouldLaunch=room.id!==priorRoomId||priorMode!==mode;
      if(shouldLaunch&&party.leaderId===partyMemberId){
        for(const member of party.members){
          if(member.id===partyMemberId)continue;
          const target=io.sockets.sockets.get(member.socketId);
          if(target)target.emit('partyLaunch',{mode,code:party.code});
        }
      }
      emitParty(party);
    }else{
      room=findRoom(mode);
    }
    myRoom=room;
    socket.data.gameMode=mode;
    socket.data.knownBulletIds=new Map();
    socket.data.v4KnownBulletIds=new Set();
    socket.data.lastRoomMetaAt=0;
    socket.data.lastRoomMetaSignature='';
    const p=makePlayer(socket.id,safe,room,false);
    p.weapon=chosenWeapon;
    p.accountKey=authedNameKey===playerNameKey(safe)?authedNameKey:null;
    room.players[socket.id]=p;
    startActiveSession(p,room,platform,accountType);
    if(room.roundState==='playing'&&!room.analyticsRoundStarted){
      analytics.logEvent('match_start',{
        mode:room.mode,
        mapId:room.currentMapId,
        roomId:room.id,
        playerCount:realPlayerCount(room),
        initialRound:true,
      });
      room.analyticsRoundStarted=true;
    }
    const myCosmetics=getPublicCosmetics(safe);
    room.roster[socket.id]={netId:p.netId,name:p.name,color:p.color,team:p.team,cosmetics:myCosmetics};
    // Populate or trim bots before this socket receives init. The very first
    // payload therefore already contains a full roster and leaderboard.
    syncBotPopulation(room);
    socket.join(`room:${room.id}`);
    socket.to(`room:${room.id}`).emit('rosterAdd',{
      id:socket.id,netId:p.netId,name:p.name,color:p.color,team:p.team,cosmetics:myCosmetics,
    });

    socket.emit('init',{
      playerId:socket.id, roomId:room.id, worldW:WORLD_W, worldH:WORLD_H, playerR:PLAYER_R,
      mapId:room.currentMapId, mapName:MAPS[room.currentMapId].name,
      mapEmoji:MAPS[room.currentMapId].emoji, mapColor:MAPS[room.currentMapId].color,
      obstacles:currentObs(room), leaderboard:getLeaderboard(room),
      roundState:room.roundState, roundEndsAt:room.roundEndsAt, roundNumber:room.roundNumber,
      roster:room.roster, mode, myTeam:p.team, myColor:p.color,
      teamKills:room.teamKills, tdmKillsToWin:TDM_KILLS_TO_WIN,
      weeklyLeaderboard:getWeeklyLB(),
      myRank:(()=>{const r=getPlayerRank(safe);const t=getTier(r.sr);const wr=getPlayerWorldRank(safe);return{sr:r.sr,progress:srProgressInTier(r.sr),worldRank:wr,tier:{name:t.name,color:t.color,emoji:t.emoji,index:t.index,glow:t.glow}};})(),
      dailyProgress: getDailyPayload(safe),
      myCosmetics, myWeapon:p.weapon, weapons:WEAPONS,
      spawn:{x:p.x,y:p.y},
      ...(room.roundState==='intermission'?{
        voteOptions:room.voteOptions.map(id=>({id,...MAPS[id],obstacles:undefined})),
        intermissionEndsAt:room.intermissionEndsAt, roundWinner:room.roundWinner,
      }:{}),
    });

    schedulePlayerCount(room);
    if(authedNameKey)emitSocialStateAndFriends(authedNameKey);
  });

  socket.on('input',(payload)=>{
    const {keys,angle,seq}=asObject(payload);
    if (!myRoom) return;
    const p=myRoom.players[socket.id];
    if (!p||myRoom.roundState!=='playing') return;
    // A newer movement packet always supersedes an older one.
    if (p.lastInputSeq>=0&&!Number.isSafeInteger(seq)) return;
    if (Number.isSafeInteger(seq)) {
      if (seq<=p.lastInputSeq) return;
      p.lastInputSeq=seq;
    }
    const input=asObject(keys);
    p.keys={
      up:input.up===true,
      down:input.down===true,
      left:input.left===true,
      right:input.right===true,
    };
    if (typeof angle==='number'&&Number.isFinite(angle)) {
      p.angle=Math.atan2(Math.sin(angle),Math.cos(angle));
    }
  });

  socket.on('shoot',(payload)=>{
    const {angle}=asObject(payload);
    if (!myRoom) return;
    const p=myRoom.players[socket.id];
    if (!p||!p.alive||myRoom.roundState!=='playing') return;
    if (p.fireCooldown>0||myRoom.bullets.length>=MAX_BULLETS) return;
    const wpn=WEAPONS[p.weapon]||WEAPONS[DEFAULT_WEAPON];
    p.fireCooldown=Math.max(1,Math.ceil(wpn.fireCooldown*killStreaks.cooldownMultiplier(p,Date.now())));
    const baseAngle=(typeof angle==='number'&&Number.isFinite(angle))
      ?Math.atan2(Math.sin(angle),Math.cos(angle))
      :p.angle;
    // A shoot packet is reliable while ordinary aim updates are disposable.
    // Store the shot angle so every other client sees the cannon aligned with
    // the projectile even if the immediately preceding input packet was lost.
    p.angle=baseAngle;
    const pellets=Math.max(1,wpn.pellets);
    const spawned=[];
    for (let i=0;i<pellets;i++) {
      // Spread pellets evenly around the aim angle (shotgun); single-pellet
      // weapons get a small random jitter instead (SMG spray).
      const a = pellets>1
        ? baseAngle + (i - (pellets-1)/2) * (wpn.spread / Math.max(1,pellets-1)) * 2
        : baseAngle + (Math.random()-0.5) * wpn.spread;
      const bullet={
        id:myRoom.bulletId++,
        x:p.x+Math.cos(a)*BULLET_MUZZLE_OFFSET, y:p.y+Math.sin(a)*BULLET_MUZZLE_OFFSET,
        vx:Math.cos(a)*wpn.bulletSpeed, vy:Math.sin(a)*wpn.bulletSpeed,
        owner:socket.id, ownerTeam:p.team, ownerColor:p.color, life:wpn.bulletLife,
        dmg:wpn.damage, r:wpn.bulletR, wpn:wpn.id,
        bouncesLeft:ricochet.ricochetsForWeapon(wpn.id),bounceCount:0,
      };
      myRoom.bullets.push(bullet);
      spawned.push(bullet);
    }
    emitV3BulletPacket(myRoom,'bulletSpawn3',spawned);
  });

  // Choosing a new weapon only takes effect while dead/respawning — this
  // keeps loadout choice a pre-spawn decision rather than a mid-fight swap.
  socket.on('selectWeapon',(payload)=>{
    const {weapon}=asObject(payload);
    if (!myRoom||!isValidWeapon(weapon)) return;
    const p=myRoom.players[socket.id];
    if (!p||p.alive) return;
    p.weapon=weapon;
    socket.emit('weaponSet',{weapon});
  });

  // LMS spectators only need bullets around the player they are watching.
  // Tracking that target avoids sending every bullet on the whole map.
  socket.on('spectateTarget', (payload) => {
    const {id}=asObject(payload);
    if (!myRoom || myRoom.mode !== 'lms') return;
    const me=myRoom.players[socket.id];
    if (!me || !me.eliminated) return;
    if (id === null) {
      me.spectateTargetId=null;
      return;
    }
    if (typeof id !== 'string' || id.length > 80) return;
    const target=myRoom.players[id];
    if (target && target.alive && !target.eliminated) me.spectateTargetId=id;
  });

  socket.on('vote',(payload)=>{
    const {mapId}=asObject(payload);
    if (!myRoom||myRoom.roundState!=='intermission') return;
    if (!myRoom.voteOptions.includes(mapId)) return;
    myRoom.votes[socket.id]=mapId;
    roomIO(myRoom).emit('voteUpdate',tallyVotes(myRoom).counts);
  });

  let lastChatTime=0;
  socket.on('chat',(payload)=>{
    const {msg,teamOnly}=asObject(payload);
    if (!myRoom) return;
    const p=myRoom.players[socket.id]; if (!p) return;
    const now=Date.now(); if (now-lastChatTime<1000) return;
    lastChatTime=now;
    const clean=typeof msg==='string'
      ?msg.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,64)
      :'';
    if (!clean) return;
    const chatPayload={id:socket.id,name:p.name,color:p.color,msg:clean,teamOnly:!!teamOnly,team:p.team};
    if (teamOnly&&myRoom.mode==='tdm'&&p.team) {
      for (const [pid,tp] of Object.entries(myRoom.players)) if(tp.team===p.team) io.to(pid).emit('chat',chatPayload);
    } else {
      roomIO(myRoom).emit('chat',chatPayload);
    }
  });

  socket.on('getRankLeaderboard',()=>{
    socket.emit('rankLeaderboard',getWorldRankings().slice(0,100));
  });

  socket.on('disconnect',()=>{
    leaveCurrentRoom('disconnect');
    leaveCurrentParty('disconnect');
    const key=authedNameKey;
    unregisterAccountSocket(socket);
    if(key)emitSocialStateAndFriends(key);
  });
});

// ── Physics — 60/s ────────────────────────────────────────────────────────────
setInterval(()=>{
  const physicsStarted=performance.now();
  const now=Date.now();
  for (const mode of ['ffa','ranked','tdm','lms']) {
    for (const room of Object.values(rooms[mode])) {
      if (room.roundState!=='playing') continue;
      const pList=Object.values(room.players);
      if (pList.length===0) continue;
      const obs=currentObs(room);

      // Respawn
      for (const p of pList) {
        if (!p.alive&&!p.eliminated&&now>=p.respawnAt) {
          const occupied=pList.filter(other=>other.id!==p.id&&other.alive);
          const sp=randomSpawnForMap(room.currentMapId,p.team,room.zone,occupied);
          p.x=sp.x; p.y=sp.y; p.hp=MAX_HP; p.alive=true;
          // Re-randomise bot wander direction on respawn
          if (p.isBot) resetBotAI(p);
        }
      }

      // Move real players
      for (const p of pList) {
        if (!p.alive||p.isBot) continue;
        if (p.fireCooldown>0) p.fireCooldown--;
        const k=p.keys; let dx=0,dy=0;
        if(k.up)dy-=1; if(k.down)dy+=1; if(k.left)dx-=1; if(k.right)dx+=1;
        if(dx||dy){
          const len=Math.sqrt(dx*dx+dy*dy);
          const speed=PLAYER_SPEED*killStreaks.movementMultiplier(p,now);
          [p.x,p.y]=moveWithSlide(p.x,p.y,dx/len*speed,dy/len*speed,PLAYER_R,obs);
        }
      }

      // Tick bots (movement + shooting handled inside tickBot)
      for (const p of pList) {
        if (p.isBot&&p.alive) tickBot(p,room);
      }

      // Bullets
      const removedBulletIds=[];
      const bouncedBullets=[];
      for (const b of room.bullets) {
        const movement=ricochet.stepBullet(b,obs,{worldW:WORLD_W,worldH:WORLD_H});
        b.life--;
        if(movement.bounced){
          const impact=movement.impact||{x:b.x,y:b.y,nx:0,ny:0};
          bouncedBullets.push([
            b.id,impact.x,impact.y,b.vx,b.vy,b.bounceCount||0,impact.nx||0,impact.ny||0,
          ]);
        }
        if(movement.removed||b.life<=0){
          b.life=0;removedBulletIds.push(b.id);continue;
        }
        const bR=b.r||BULLET_R;
        for (const p of pList) {
          if(!p.alive||p.id===b.owner) continue;
          if(room.mode==='tdm'&&p.team===b.ownerTeam) continue;
          const dx=p.x-b.x, dy=p.y-b.y;
          if(dx*dx+dy*dy<(PLAYER_R+bR)**2) {
            const dmg=b.dmg||DAMAGE;
            const absorbed=killStreaks.absorbDamage(p,dmg,now);
            const actualDamage=Math.min(Math.max(0,p.hp),absorbed.hpDamage);
            b.life=0;removedBulletIds.push(b.id);p.hp-=absorbed.hpDamage;
            const dmgShooter=room.players[b.owner];
            if(dmgShooter) {
              dmgShooter.damageDealt=(dmgShooter.damageDealt||0)+actualDamage;
              if (p.isBot) dmgShooter.botDamageDealt=(dmgShooter.botDamageDealt||0)+actualDamage;
              else dmgShooter.realDamageDealt=(dmgShooter.realDamageDealt||0)+actualDamage;
            }
            // Only send damage events to real players (bots don't have sockets)
            if (!p.isBot) io.to(p.id).emit('damaged',{
              hp:Math.max(0,p.hp),shield:absorbed.shield,shieldDamage:absorbed.shieldDamage,
            });
            if(p.hp<=0){
              finalizeDeath(room,p,now);
              const shooter=room.players[b.owner];
              if(shooter){
                const ricochetBounces=Math.max(0,Number(b.bounceCount)||0);
                const killPoints=ricochet.killPointsForBounces(ricochetBounces);
                shooter.kills++; shooter.score+=killPoints;
                awardKillStreak(room,shooter,now);
                shooter.noDeathKills=(shooter.noDeathKills||0)+1;
                shooter.bestNoDeathKills=Math.max(shooter.bestNoDeathKills||0,shooter.noDeathKills);
                if (p.isBot) shooter.botKills=(shooter.botKills||0)+1;
                else shooter.realKills=(shooter.realKills||0)+1;
                if(ricochetBounces>0){
                  const ricochetBucket=p.isBot?'ricochetKillsBot':'ricochetKillsReal';
                  shooter[ricochetBucket]=(shooter[ricochetBucket]||0)+1;
                  shooter.bestRicochetBounces=Math.max(shooter.bestRicochetBounces||0,ricochetBounces);
                }
                const killWeapon=isValidWeapon(b.wpn)?b.wpn:(isValidWeapon(shooter.weapon)?shooter.weapon:DEFAULT_WEAPON);
                const weaponBucket=p.isBot?'weaponKillsBot':'weaponKillsReal';
                if (!shooter[weaponBucket]) shooter[weaponBucket]={};
                shooter[weaponBucket][killWeapon]=(shooter[weaponBucket][killWeapon]||0)+1;
                healOnKill(shooter);

                // ── Reactive chat on kill ────────────────────────────────────
                // Bot killer reacts; also the dying bot sometimes reacts
                const REACT_COOLDOWN = 8000; // don't spam — 8s min between reactive msgs
                if (shooter.isBot && now - shooter.botLastReactChatAt > REACT_COOLDOWN) {
                  // Higher kills = more likely to taunt (ego scales with score)
                  const talkChance = 0.30 + Math.min(0.35, shooter.kills * 0.04);
                  if (Math.random() < talkChance) {
                    const pool = shooter.kills >= 5 ? [...BOT_CHAT.killed, ...BOT_CHAT.topRound] : BOT_CHAT.killed;
                    const msg = pool[Math.floor(Math.random()*pool.length)];
                    roomIO(room).emit('chat', { id:shooter.id, name:shooter.name, color:shooter.color, msg, teamOnly:false, team:shooter.team });
                    shooter.botLastReactChatAt = now;
                  }
                }
                // Victim bot sometimes vents
                if (p.isBot && now - p.botLastReactChatAt > REACT_COOLDOWN) {
                  if (Math.random() < 0.22) {
                    const pool = p.hp <= 0 ? BOT_CHAT.died : BOT_CHAT.random;
                    const msg = pool[Math.floor(Math.random()*pool.length)];
                    roomIO(room).emit('chat', { id:p.id, name:p.name, color:p.color, msg, teamOnly:false, team:p.team });
                    p.botLastReactChatAt = now;
                  }
                }

                if(room.mode==='tdm'&&shooter.team){
                  room.teamKills[shooter.team]=(room.teamKills[shooter.team]||0)+1;
                  roomIO(room).emit('teamKills',room.teamKills);
                  if(room.teamKills[shooter.team]>=TDM_KILLS_TO_WIN){
                    room.leaderboardDirty=true;
                    const killerCos=shooter.isBot?null:getPublicCosmetics(shooter.name);
                    roomIO(room).emit('kill',{killerName:shooter.name,killerColor:shooter.color,killerTeam:shooter.team,victimName:p.name,victimColor:p.color,victimTeam:p.team,killerCosmetics:killerCos,ricochetBounces,killPoints,ricochetBonus:killPoints-100});
                    roomIO(room).emit('leaderboard',getLeaderboard(room));
                    if(!p.isBot) roomIO(room).emit('died',{victimId:p.id,respawnIn:RESPAWN_MS});
                    startIntermission(room); room.bullets.length=0; break;
                  }
                }
                room.leaderboardDirty=true;
                {
                  const killerCos=shooter.isBot?null:getPublicCosmetics(shooter.name);
                  roomIO(room).emit('kill',{killerName:shooter.name,killerColor:shooter.color,killerTeam:shooter.team,victimName:p.name,victimColor:p.color,victimTeam:p.team,killerCosmetics:killerCos,ricochetBounces,killPoints,ricochetBonus:killPoints-100});
                }
                roomIO(room).emit('leaderboard',getLeaderboard(room));
              }
              if(room.roundState==='playing'&&!p.isBot) roomIO(room).emit('died',{victimId:p.id,respawnIn:p.eliminated?null:RESPAWN_MS,eliminated:!!p.eliminated});
            }
            break;
          }
        }
      }
      for(let i=room.bullets.length-1;i>=0;i--) if(room.bullets[i].life<=0) room.bullets.splice(i,1);
      emitBulletBounces(room,bouncedBullets);
      emitV3BulletGone(room,removedBulletIds);

      // ── Last Man Standing: zone + grace-period elimination + win check ─────────
      if (room.mode==='lms') {
        if (!room.finalStandAnnounced && now>=room.lmsGraceEndsAt) {
          room.finalStandAnnounced=true;
          roomIO(room).emit('finalStand',{});
        }
        updateLmsZone(room, now);
        if (room.zone && now>=(room.zoneNextDamageAt||0)) {
          room.zoneNextDamageAt=now+1000;
          for (const p of pList) {
            if (!p.alive) continue;
            const dx=p.x-room.zone.cx, dy=p.y-room.zone.cy;
            if (Math.sqrt(dx*dx+dy*dy) <= room.zone.radius) continue;
            p.hp-=LMS_ZONE_DPS;
            if (!p.isBot) io.to(p.id).emit('damaged',{hp:Math.max(0,p.hp)});
            if (p.hp<=0) {
              finalizeDeath(room,p,now);
              if (!p.isBot) roomIO(room).emit('died',{victimId:p.id,respawnIn:p.eliminated?null:RESPAWN_MS,eliminated:!!p.eliminated,zone:true});
            }
          }
        }
        if (room.roundState==='playing' && pList.length>1 && now>=room.lmsGraceEndsAt) {
          // A player defeated just before grace ends may still be waiting for
          // their allowed respawn. Count everyone not finally eliminated, and
          // only finish once the sole contender is actually alive.
          const contenders=pList.filter(p=>!p.eliminated);
          if (contenders.length===0||(contenders.length===1&&contenders[0].alive)) {
            startIntermission(room);
          }
        }
      }
    }
  }
  runtimeMetrics.recordPhysicsTick(performance.now()-physicsStarted);
},PHYSICS_MS);

// ── Round timer ───────────────────────────────────────────────────────────────
setInterval(()=>{
  const now=Date.now();
  for(const mode of['ffa','ranked','tdm','lms']) for(const room of Object.values(rooms[mode])){
    if(room.roundState==='playing'&&now>=room.roundEndsAt) startIntermission(room);
    else if(room.roundState==='intermission'&&now>=room.intermissionEndsAt) startRound(room,tallyVotes(room).winner);
  }
},500);

// ── Bot balance — every 10 seconds ───────────────────────────────────────────
setInterval(balanceBots, 10000);

// ── Broadcast — 20/s ─────────────────────────────────────────────────────────
setInterval(()=>{
  const broadcastStarted=performance.now();
  const now=Date.now();
  for(const mode of['ffa','ranked','tdm','lms']) for(const room of Object.values(rooms[mode])){
    const pList=Object.values(room.players); if(pList.length===0) continue;
    const allBullets=room.roundState==='playing'?room.bullets:[];
    const timeLeftSec=room.roundState==='playing'
      ?Math.max(0,Math.ceil((room.roundEndsAt-now)/1000))
      :Math.max(0,Math.ceil((room.intermissionEndsAt-now)/1000));

    const lmsAlive=room.mode==='lms'?pList.filter(p=>!p.eliminated).length:undefined;
    const lmsZoneInfo=room.mode==='lms'?getLmsZoneInfo(room,now):null;

    const snapshotSeq=room.snapshotSeq=(room.snapshotSeq+1)>>>0;
    const socketIds=io.sockets.adapter.rooms.get(`room:${room.id}`);
    if(!socketIds)continue;
    for(const sid of socketIds){
      const sock=io.sockets.sockets.get(sid);
      if(!sock)continue;
      const me=room.players[sid]; if(!me||me.isBot) continue;
      const stream=socketStreamContext(room,sid,sock);
      if(!stream)continue;
      const {isSpectator,anchor:spectateAnchor}=stream;
      const usesDynamicViewport=sock.data.compactStateVersion>=3;
      const visiblePlayers=isSpectator
        ?pList
        :pList.filter(p=>inViewport(
          p.x,p.y,me.x,me.y,
          usesDynamicViewport?stream.padX:VIEWPORT_PAD,
          usesDynamicViewport?stream.padY:VIEWPORT_PAD
        ));
      const visBullets=allBullets.filter(b=>inViewport(
        b.x,b.y,spectateAnchor.x,spectateAnchor.y,
        usesDynamicViewport?stream.padX:VIEWPORT_PAD,
        usesDynamicViewport?stream.padY:VIEWPORT_PAD
      ));
      if (
        sock.data.compactStateVersion===2
        ||sock.data.compactStateVersion===3
        ||sock.data.compactStateVersion===4
      ) {
        const endsAt=room.roundState==='playing'?room.roundEndsAt:room.intermissionEndsAt;
        const urgentMetaSignature=[
          room.roundState,
          endsAt,
          room.mode==='tdm'?room.teamKills.red:0,
          room.mode==='tdm'?room.teamKills.blue:0,
          lmsAlive??-1,
          isSpectator?1:0,
        ].join('|');
        if (
          now-sock.data.lastRoomMetaAt>=500
          || urgentMetaSignature!==sock.data.lastRoomMetaSignature
        ) {
          sock.data.lastRoomMetaAt=now;
          sock.data.lastRoomMetaSignature=urgentMetaSignature;
          const metaPayload=networkCodec.encodeRoomMeta({
            seq:snapshotSeq,
            roundState:room.roundState,
            endsAt,
            teamKills:room.mode==='tdm'?room.teamKills:null,
            zone:lmsZoneInfo,
            graceEndsAt:room.mode==='lms'?room.lmsGraceEndsAt:null,
            lmsAlive,
            isSpectator,
          });
          runtimeMetrics.recordRealtime(room.mode,'roomMeta2',metaPayload);
          sock.volatile.emit('roomMeta2',metaPayload);
        }

        // Do not alter active combat: current visible matches remain at 20 Hz.
        // Only background tabs and the motionless intermission screen use 5 Hz.
        const inactiveStream=sock.data.networkHidden||room.roundState!=='playing';
        if (inactiveStream&&snapshotSeq%4!==0) continue;

        if(sock.data.compactStateVersion===4){
          // A v4 tick is one atomic binary event. Bullet spawns/removals are
          // derived from each socket's last queued visible set, so a crowded
          // fight no longer creates hundreds of tiny reliable events that can
          // sit ahead of movement and pongs on a slow or polling connection.
          const transportWritable=sock.conn?.transport?.writable!==false;
          if(!transportWritable)continue;
          const previousIds=sock.data.v4KnownBulletIds instanceof Set
            ?sock.data.v4KnownBulletIds
            :new Set();
          const currentIds=new Set(visBullets.map(bullet=>bullet.id));
          const fullCorrection=snapshotSeq%BULLET_CORRECTION_DIVISOR===0;
          let bulletMode=0;
          let changedBullets=[];
          let goneIds=[];
          if(fullCorrection){
            bulletMode=1;
            changedBullets=visBullets;
          }else{
            changedBullets=visBullets.filter(bullet=>!previousIds.has(bullet.id));
            goneIds=[...previousIds].filter(id=>!currentIds.has(id));
            if(changedBullets.length||goneIds.length)bulletMode=2;
          }
          const statePacket=networkCodec.encodeStatePacket(
            snapshotSeq,
            visiblePlayers,
            sid,
            {
              bulletMode,
              bullets:changedBullets,
              goneIds,
              playersById:room.players,
            },
          );
          runtimeMetrics.recordRealtime(room.mode,'state4',statePacket);
          sock.volatile.emit('state4',statePacket);
          sock.data.v4KnownBulletIds=currentIds;
          continue;
        }

        if(sock.data.compactStateVersion===3){
          const playerPacket=networkCodec.encodePlayerPacket(snapshotSeq,visiblePlayers,sid);
          runtimeMetrics.recordRealtime(room.mode,'state3',playerPacket);
          if(snapshotSeq%BULLET_CORRECTION_DIVISOR===0){
            const bulletPacket=networkCodec.encodeBulletPacket(snapshotSeq,visBullets,room.players);
            runtimeMetrics.recordRealtime(room.mode,'bullets3',bulletPacket);
            // One atomic volatile Socket.IO event prevents a second
            // back-to-back event from being discarded while the first frame is
            // still flushing.
            sock.volatile.emit('state3',playerPacket,bulletPacket);
          }else{
            sock.volatile.emit('state3',playerPacket);
          }
          continue;
        }

        const previousBulletAges=sock.data.knownBulletIds instanceof Map
          ?sock.data.knownBulletIds
          :new Map();
        const nextBulletAges=new Map();
        const packedBullets=visBullets.map(b=>{
          const age=previousBulletAges.get(b.id)||0;
          // Repeat spawn metadata briefly so a disposable snapshot dropped
          // during congestion cannot make a new projectile look stationary.
          const includeMetadata=age<5||snapshotSeq%20===0;
          nextBulletAges.set(b.id,Math.min(age+1,1000));
          return networkCodec.encodeBullet(b,includeMetadata);
        });
        sock.data.knownBulletIds=nextBulletAges;
        const compactPayload=[
          snapshotSeq,
          now,
          visiblePlayers.map(p=>networkCodec.encodePlayer(p,sid)),
          packedBullets,
        ];
        runtimeMetrics.recordRealtime(room.mode,'state2',compactPayload);
        sock.volatile.emit('state2',compactPayload);
        continue;
      }

      const visPlayers=visiblePlayers.map(p=>({
        id:p.id, x:p.x|0, y:p.y|0, angle:Math.round(p.angle*10)/10,
        hp:p.hp, alive:p.alive, team:p.team, eliminated:!!p.eliminated,
        ...(p.id===sid?{kills:p.kills,score:p.score}:{}),
      }));
      const legacyBullets=visBullets.map(b=>({
        id:b.id,x:b.x|0,y:b.y|0,vx:b.vx,vy:b.vy,c:b.ownerColor,w:b.wpn,
      }));
      // Snapshots are disposable: never queue stale positions behind a brief
      // network or device slowdown.
      const legacyPayload={
        seq:snapshotSeq, serverNow:now,
        players:visPlayers, bullets:legacyBullets,
        roundState:room.roundState, t:timeLeftSec,
        teamKills:room.mode==='tdm'?room.teamKills:undefined,
        zone:lmsZoneInfo||undefined,
        graceEndsAt:room.mode==='lms'?room.lmsGraceEndsAt:undefined,
        lmsAlive, isSpectator,
      };
      runtimeMetrics.recordRealtime(room.mode,'state',legacyPayload);
      sock.volatile.emit('state',legacyPayload);
    }
  }
  runtimeMetrics.recordBroadcastTick(performance.now()-broadcastStarted);
},BROADCAST_MS);

// Accumulate player-hours for the bandwidth-per-player estimate without adding
// any database writes. This is process-local and resets on deployment.
const playerTimeMetric=setInterval(()=>{
  runtimeMetrics.recordPlayerTime(currentOnlineCount(),10);
},10000);
if(typeof playerTimeMetric.unref==='function')playerTimeMetric.unref();


// ── Startup: use MongoDB when configured, otherwise run in memory ─────────────
const PORT = process.env.PORT || 3000;

async function startServer() {
  if (MONGO_URI) {
    try {
      await connectDB();
      await loadRanksFromDB();
      await loadWeeklyFromDB();
      await loadDailyProgressFromDB();
    } catch (err) {
      db = null;
      analytics.init(null);
      await announcements.init(null);
      console.error('MongoDB unavailable; continuing with in-memory data:', err.message);
    }
  } else {
    analytics.init(null);
    await announcements.init(null);
    weekly = { weekKey:getWeekKey(), entries:[], prevWeek:null };
    console.warn('MONGODB_URI is not set; progress, analytics, and announcements reset on restart.');
  }

  const storage = db ? 'MongoDB connected' : 'in-memory storage';
  server.listen(PORT, () => {
    const listeningPort=server.address()?.port||PORT;
    console.log(`Arena.io — port ${listeningPort} — ${storage}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start Arena.io:', err);
  process.exit(1);
});
