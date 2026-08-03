'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  encodePlayer,
  encodeBullet,
  encodeRoomMeta,
  encodePlayerPacket,
  encodeBulletPacket,
  encodeStatePacket,
} = require('../network-codec');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

test('compact snapshots preserve the gameplay fields the renderer needs', () => {
  const player = {
    id:'p1', x:123.8, y:456.2, angle:1.23456, hp:75,
    alive:true, eliminated:false, kills:9, score:14,
  };
  const bullet = {
    id:44, x:300.7, y:400.4, vx:9.8765, vy:-1.2345,
    owner:'p1', wpn:'sniper',
  };
  assert.deepEqual(encodePlayer(player, 'p1'), ['p1',123,456,1235,75,1,9,14]);
  assert.deepEqual(
    encodeBullet(bullet, true),
    [44,300,400,9877,-1234,'p1',3],
  );
  assert.deepEqual(encodeBullet(bullet, false), [44,300,400]);
});

test('compact protocol substantially reduces representative snapshot bytes', () => {
  const players = Array.from({length:12}, (_, index) => ({
    id:`socket-${index}`, x:500+index*31, y:800+index*17,
    angle:index/7, hp:100-index*3, alive:true, eliminated:false,
    kills:index, score:index*2, team:index%2?'red':'blue',
  }));
  const bullets = Array.from({length:40}, (_, index) => ({
    id:index+1, x:300+index*9, y:900-index*7,
    vx:9.1234, vy:-3.4567, owner:`socket-${index%12}`,
    ownerColor:'#e74c3c', wpn:index%3?'smg':'shotgun',
  }));
  const legacy = {
    seq:99, serverNow:Date.now(),
    players:players.map(player => ({
      id:player.id, x:player.x, y:player.y, angle:Math.round(player.angle*10)/10,
      hp:player.hp, alive:player.alive, team:player.team,
      eliminated:player.eliminated,
    })),
    bullets:bullets.map(bullet => ({
      id:bullet.id, x:bullet.x, y:bullet.y, vx:bullet.vx, vy:bullet.vy,
      c:bullet.ownerColor, w:bullet.wpn,
    })),
    roundState:'playing', t:91, zone:undefined,
  };
  const compact = [
    99,
    legacy.serverNow,
    players.map(player => encodePlayer(player, 'socket-0')),
    bullets.map(bullet => encodeBullet(bullet, true)),
  ];
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy));
  const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(
    compactBytes < legacyBytes * 0.55,
    `expected compact packet below 55% of legacy size (${compactBytes}/${legacyBytes})`,
  );
});

test('binary v3 stays below 70 kbps for a busy representative fight',()=>{
  const players=Array.from({length:12},(_,index)=>({
    id:`socket-${index}`,netId:index+1,
    x:500+index*31,y:800+index*17,angle:index/7,
    hp:100-index*3,alive:true,eliminated:false,kills:index,score:index*100,
  }));
  const playersById=Object.fromEntries(players.map(player=>[player.id,player]));
  const bullets=Array.from({length:40},(_,index)=>({
    id:index+1,x:300+index*9,y:900-index*7,
    vx:9.1234,vy:-3.4567,owner:`socket-${index%12}`,
    wpn:index%3?'smg':'shotgun',
  }));
  const playerPacket=encodePlayerPacket(99,players,'socket-0');
  const bulletPacket=encodeBulletPacket(99,bullets,playersById);
  assert.equal(playerPacket.length,7+players.length*10+4);
  assert.equal(bulletPacket.length,7+bullets.length*15);
  // Allow about 60 bytes for Socket.IO's event placeholder and framing.
  const bytesPerSecond=(playerPacket.length+60)*20+(bulletPacket.length+60)*5;
  const kilobitsPerSecond=bytesPerSecond*8/1000;
  assert.ok(kilobitsPerSecond<70,`expected under 70 kbps, measured ${kilobitsPerSecond}`);
});

test('binary v3 preserves absolute player and projectile fields',()=>{
  const player={
    id:'socket-a',netId:27,x:1234.4,y:987.6,angle:-1.25,
    hp:76,alive:true,eliminated:false,kills:5,score:900,
  };
  const playerPacket=encodePlayerPacket(123,[player],player.id);
  assert.equal(playerPacket.readUInt8(0),1);
  assert.equal(playerPacket.readUInt32LE(1),123);
  assert.equal(playerPacket.readUInt16LE(7),27);
  assert.equal(playerPacket.readUInt16LE(9),1234);
  assert.equal(playerPacket.readUInt16LE(11),988);
  assert.equal(playerPacket.readUInt8(15),76);
  assert.equal(playerPacket.readUInt8(16)&4,4);
  assert.equal(playerPacket.readUInt16LE(17),5);
  assert.equal(playerPacket.readUInt16LE(19),900);

  const bullet={id:400000,x:700,y:800,vx:15.5,vy:-2.25,owner:player.id,wpn:'sniper'};
  const bulletPacket=encodeBulletPacket(124,[bullet],{[player.id]:player});
  assert.equal(bulletPacket.readUInt8(0),2);
  assert.equal(bulletPacket.readUInt32LE(7),400000);
  assert.equal(bulletPacket.readUInt16LE(11),700);
  assert.equal(bulletPacket.readUInt16LE(13),800);
  assert.equal(bulletPacket.readInt16LE(15)/256,15.5);
  assert.equal(bulletPacket.readInt16LE(17)/256,-2.25);
  assert.equal(bulletPacket.readUInt16LE(19),27);
  assert.equal(bulletPacket.readUInt8(21),3);
});

test('binary v4 combines players, input acknowledgements and bullet deltas',()=>{
  const self={
    id:'socket-a',netId:27,x:1234.4,y:987.6,angle:-1.25,
    hp:76,alive:true,eliminated:false,kills:5,score:900,lastInputSeq:321,
  };
  const other={
    id:'socket-b',netId:28,x:850,y:420,angle:.5,
    hp:100,alive:true,eliminated:false,kills:2,score:300,lastInputSeq:11,
  };
  const bullet={
    id:400000,x:700,y:800,vx:15.5,vy:-2.25,owner:self.id,wpn:'sniper',
  };
  const packet=encodeStatePacket(124,[self,other],self.id,{
    bulletMode:2,
    bullets:[bullet],
    goneIds:[88,89],
    playersById:{[self.id]:self,[other.id]:other},
  });
  assert.equal(packet.length,12+18+10+15+8);
  assert.equal(packet.readUInt8(0),4);
  assert.equal(packet.readUInt32LE(1),124);
  assert.equal(packet.readUInt16LE(5),2);
  assert.equal(packet.readUInt8(7),2);
  assert.equal(packet.readUInt16LE(8),1);
  assert.equal(packet.readUInt16LE(10),2);
  assert.equal(packet.readUInt16LE(12),27);
  assert.equal(packet.readUInt8(21)&4,4);
  assert.equal(packet.readUInt16LE(22),5);
  assert.equal(packet.readUInt16LE(24),900);
  assert.equal(packet.readUInt32LE(26),321);
  assert.equal(packet.readUInt32LE(40),400000);
  assert.equal(packet.readUInt32LE(55),88);
  assert.equal(packet.readUInt32LE(59),89);
});

test('binary v4 stays below 70 kbps for a busy representative fight',()=>{
  const players=Array.from({length:12},(_,index)=>({
    id:`socket-${index}`,netId:index+1,
    x:500+index*31,y:800+index*17,angle:index/7,
    hp:100-index*3,alive:true,eliminated:false,kills:index,score:index*100,
    lastInputSeq:100+index,
  }));
  const playersById=Object.fromEntries(players.map(player=>[player.id,player]));
  const bullets=Array.from({length:40},(_,index)=>({
    id:index+1,x:300+index*9,y:900-index*7,
    vx:9.1234,vy:-3.4567,owner:`socket-${index%12}`,
    wpn:index%3?'smg':'shotgun',
  }));
  const movementOnly=encodeStatePacket(99,players,'socket-0');
  const correction=encodeStatePacket(100,players,'socket-0',{
    bulletMode:1,bullets,playersById,
  });
  // Three movement-only ticks plus a full bullet correction every 200 ms.
  // Allow about 60 bytes per Socket.IO event for attachment/framing overhead.
  const bytesPerSecond=(movementOnly.length+60)*15+(correction.length+60)*5;
  const kilobitsPerSecond=bytesPerSecond*8/1000;
  assert.ok(kilobitsPerSecond<70,`expected under 70 kbps, measured ${kilobitsPerSecond}`);
});

test('room metadata is separated from 20 Hz movement snapshots', () => {
  const packet = encodeRoomMeta({
    seq:5,
    roundState:'playing',
    endsAt:123456,
    teamKills:{red:4,blue:3},
    zone:{
      cx:100,cy:200,r:300,nextCx:120,nextCy:220,nextR:180,
      phaseEndsAt:123000,shrinking:true,complete:false,
    },
    graceEndsAt:120000,
    lmsAlive:6,
    isSpectator:false,
  });
  assert.deepEqual(packet, [
    5,0,123456,4,3,[100,200,300,120,220,180,123000,1,0],120000,6,0,
  ]);
  assert.match(server, /compactStateVersion/);
  assert.match(server, /sock\.volatile\.emit\('state2'/);
  assert.match(server, /sock\.volatile\.emit\('state3'/);
  assert.match(server, /sock\.volatile\.emit\('state4'/);
  assert.match(server, /sock\.volatile\.emit\('state3',playerPacket,bulletPacket\)/);
  assert.match(server, /sock\.volatile\.emit\('roomMeta2'/);
  assert.match(client, /socket\.on\('state2'/);
  assert.match(client, /socket\.on\('state3'/);
  assert.match(client, /socket\.on\('state4'/);
  assert.match(client, /socket\.on\('bullets3'/);
  assert.match(client, /socket\.on\('roomMeta2'/);
});

test('active combat remains at 20 Hz while only inactive views are throttled', () => {
  assert.match(server, /const BROADCAST_MS = 1000 \/ 20/);
  assert.match(server, /BULLET_CORRECTION_DIVISOR = 4/);
  assert.match(server, /encodePlayerPacket\(snapshotSeq,visiblePlayers,sid\)/);
  assert.match(server, /const inactiveStream=sock\.data\.networkHidden\|\|room\.roundState!=='playing'/);
  assert.match(server, /inactiveStream&&snapshotSeq%4!==0/);
  assert.match(client, /networkVisibility/);
  assert.match(client, /hidden:document\.hidden/);
});

test('ping checks and static asset requests use less bandwidth', () => {
  assert.match(client, /setInterval\(sendPing,5000\)/);
  assert.match(client, /payload\.metrics=\{ping,fps,platform:CLIENT_PLATFORM\}/);
  assert.doesNotMatch(client,/performanceTimer=setInterval/);
  assert.match(server, /max-age=31536000, immutable/);
  assert.match(server,/app\.use\(compression\(\{threshold:1024\}\)\)/);
  assert.match(serviceWorker, /arena-shell-v/);
  assert.match(serviceWorker, /staleWhileRevalidate/);
  assert.match(serviceWorker, /\/socket\.io\//);
});

test('v4 uses real viewport interest management and safe rolling fallback',()=>{
  assert.match(client,/viewport:\{w:VW,h:VH\}/);
  assert.match(client,/clientViewport/);
  assert.match(server,/VIEWPORT_MARGIN = 320/);
  assert.match(server,/usesDynamicViewport\?stream\.padX:VIEWPORT_PAD/);
  assert.match(client,/requestVersion\(4,/);
  assert.match(client,/requestVersion\(3,/);
  assert.match(client,/socket\.timeout\(3000\)\.emit/);
  assert.match(client,/\{compactState:2\}/);
  assert.match(server,/compactState===4\?4:compactState===3\?3:compactState===2\?2:0/);
});

test('WebSocket is attempted before polling without removing the fallback',()=>{
  assert.match(client,/transports:\['websocket','polling'\]/);
  assert.match(client,/tryAllTransports:true/);
  assert.match(client,/rememberUpgrade:true/);
});

test('v4 batches projectile lifecycle changes into the disposable state event',()=>{
  assert.match(server,/encodeStatePacket\(/);
  assert.match(server,/bulletMode=2/);
  assert.match(server,/goneIds=\[\.\.\.previousIds\]/);
  assert.match(server,/sock\.volatile\.emit\('state4',statePacket\)/);
  assert.match(server,/compactStateVersion!==3/);
});
