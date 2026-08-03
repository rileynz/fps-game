'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const challenges=fs.readFileSync(path.join(root,'challenges.js'),'utf8');

test('ricochet is a core mechanic with restrained Arena.io feedback',()=>{
  assert.match(html,/Ricochet Combat · Every Wall Is A Weapon/);
  assert.match(html,/function drawAimGuide\(/);
  assert.match(html,/function drawRicochetBursts\(/);
  assert.match(html,/id="ricochet-toast"/);
  assert.match(html,/SoundFX\.play\('ricochet'\)/);
  assert.match(html,/socket\.on\('bulletBounce'/);
});

test('server keeps ricochets authoritative and low bandwidth',()=>{
  assert.match(server,/ricochet\.stepBullet\(b,obs/);
  assert.match(server,/function emitBulletBounces\(/);
  assert.match(server,/runtimeMetrics\.recordRealtime\(room\.mode,'bulletBounce'/);
  assert.match(server,/sock\.volatile\.emit\('bulletBounce',visible\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'network-codec.js'),'utf8'),/bounceCount/);
});

test('projectiles leave the visible muzzle and turrets face their shots',()=>{
  assert.match(server,/const BULLET_MUZZLE_OFFSET = PLAYER_R \+ 16/);
  assert.ok((server.match(/Math\.cos\(a\)\*BULLET_MUZZLE_OFFSET/g)||[]).length>=2);
  assert.match(server,/p\.angle=baseAngle/);
  assert.match(server,/const desiredAim=Math\.atan2\(aimY-bot\.y,aimX-bot\.x\)/);
  assert.doesNotMatch(server,/desiredAim=Math\.atan2\([^\n]+\)\+spread/);
  assert.match(html,/function muzzleOffset\(radius=playerR\)\{return radius\+16;\}/);
  assert.match(html,/spawnLocalShotVisual\(local\.angle,myWeapon,ts\)/);
});

test('latency display and prediction reject a single delayed ping sample',()=>{
  assert.match(html,/const rttSamples=\[\]/);
  assert.match(html,/const stableSample=rttSamples\.slice\(\)\.sort\(\(a,b\)=>a-b\)\[1\]/);
  assert.match(html,/networkRttMs=stableSample/);
});

test('bank eliminations have progression hooks without a new menu mode',()=>{
  assert.match(challenges,/ricochet_kills/);
  assert.match(challenges,/weekly_ricochet/);
  assert.match(server,/challengeRicochetKills/);
  assert.doesNotMatch(html,/data-mode="ricochet"/);
});
