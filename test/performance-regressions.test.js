'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('latest-news preview clamps and wraps long content', () => {
  assert.match(client, /#map-copy\{display:flex;/);
  assert.match(client, /#map-title\{[^}]*overflow-wrap:anywhere;[^}]*-webkit-line-clamp:2/);
  assert.match(client, /#map-body\{[^}]*overflow-wrap:anywhere;[^}]*-webkit-line-clamp:2/);
});

test('broadcasts iterate only sockets that belong to the room', () => {
  assert.match(server, /io\.sockets\.adapter\.rooms\.get\(`room:\$\{room\.id\}`\)/);
  assert.doesNotMatch(server, /for\(const\[sid,sock\] of io\.sockets\.sockets\)/);
});

test('realtime snapshots do not queue stale movement', () => {
  assert.match(server, /sock\.volatile\.emit\('state'/);
  assert.match(server, /snapshotSeq/);
  assert.match(client, /state\.seq<=lastSnapshotSeq/);
});

test('movement inputs are sequenced and every control transition stays reliable', () => {
  assert.match(client, /seq:\+\+inputSeq/);
  assert.match(client, /socket\.volatile\.emit\('input',payload\)/);
  assert.match(client, /if\(keysChanged\)\{/);
  assert.match(client, /lastControlTransitionSeq=payload\.seq/);
  assert.match(client, /socket\.emit\('input',payload\)/);
  assert.match(server, /seq<=p\.lastInputSeq/);
});

test('local reconciliation waits for input ack and replays the full network trip',()=>{
  assert.match(client,/inputAck=view\.getUint32/);
  assert.match(client,/lastServerInputAck<lastControlTransitionSeq/);
  assert.match(client,/networkRttMs=stableSample/);
  assert.match(client,/rttSamples\.slice\(\)\.sort/);
  assert.match(client,/performance\.now\(\)-lastSnapshotAt/);
  assert.match(client,/\(networkRttMs\|\|ping\|\|0\)\+snapshotAgeMs/);
  assert.doesNotMatch(client,/\(ping\|\|0\)\*0\.5\+snapshotIntervalMs\*0\.5/);
  assert.match(client,/movePredictedPoint\(targetX,targetY,moveX,moveY,stepDistance\)/);
  assert.match(server,/p\.lastInputSeq/);
});

test('mobile prediction uses the same digital movement vector as the server',()=>{
  assert.match(client,/up:joyMove\.dy<-0\.2/);
  assert.match(client,/right:joyMove\.dx>0\.2/);
  assert.match(client,/function movementVector\(keysNow=currentMovementKeys\(\)\)/);
  assert.match(client,/const length=Math\.sqrt\(dx\*dx\+dy\*dy\)/);
});

test('remote movement adapts interpolation to packet jitter', () => {
  assert.match(client, /snapshotJitterMs/);
  assert.match(client, /interpPeriodMs=clamp\(snapshotIntervalMs\+snapshotJitterMs\*1\.5,52,120\)/);
  assert.match(client, /Math\.atan2\(Math\.sin\(p\.angle-pp\.angle\),Math\.cos\(p\.angle-pp\.angle\)\)/);
  assert.match(client, /prevPlayersById=new Map\(prevState\.players\.map/);
});

test('expensive trail layers scale down only on struggling devices', () => {
  assert.match(client, /const reducedEffects=fps>0&&fps<42/);
  assert.match(client, /ctx\.shadowBlur=reducedEffects\?0/);
});

test('prediction and extrapolation are bounded across long frames', () => {
  assert.match(client, /Math\.min\(dt,50\)\/16\.67/);
  assert.match(client, /Math\.min\(now-tr\.lastSeen,Math\.max\(280,interpPeriodMs\*3\)\)/);
  assert.match(client, /const cameraEase=1-Math\.pow\(\.9,Math\.min\(dt,50\)\/16\.67\)/);
});

test('LMS spectators receive bullets around their watched player', () => {
  assert.match(server, /spectateAnchor/);
  assert.match(server, /b\.x,b\.y,spectateAnchor\.x,spectateAnchor\.y/);
  assert.doesNotMatch(server, /isSpectator\?allBullets/);
});

test('LMS storm rendering avoids the old full-screen even-odd cutout', () => {
  assert.doesNotMatch(client, /fill\('evenodd'\)/);
  assert.doesNotMatch(client, /setLineDash\(\[12,7\]\)/);
  assert.match(client, /lastLmsZoneTimerText/);
  assert.match(client, /id="storm-danger-overlay"/);
  assert.match(client, /OUTSIDE STORM — MOVE TO SAFETY/);
  assert.doesNotMatch(client, /fillText\('SAFE ZONE'/);
  assert.doesNotMatch(client, /ctx\.moveTo\(18,0\).*SAFE ZONE/s);
});

test('smarter bots use throttled perception and real weapon stats', () => {
  assert.match(server, /BOT_THINK_MS/);
  assert.match(server, /bot\.botNextThinkAt/);
  assert.match(server, /steerBotAroundObstacle/);
  assert.match(server, /getBotSafeZoneTarget/);
  assert.match(server, /info\.nextCx/);
  assert.match(server, /info\.nextCy/);
  assert.match(server, /botTargetVx/);
  assert.match(server, /botWeapon\.bulletSpeed/);
  assert.match(server, /botWeapon\.fireCooldown/);
});

test('LMS preview draws at the upcoming circle centre', () => {
  assert.match(client, /currentZone\.nextCx\?\?currentZone\.cx/);
  assert.match(client, /currentZone\.nextCy\?\?currentZone\.cy/);
  assert.match(client, /mmX\.arc\(nextCx\*sx,nextCy\*sy,currentZone\.nextR\*sx/);
  assert.match(client, /ctx\.arc\(nsx,nsy,nr/);
});
