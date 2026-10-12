'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const premium=fs.readFileSync(path.join(root,'premium-shop.js'),'utf8');

test('round reset clears stale input and immediately synchronizes spawn and leaderboard',()=>{
  assert.match(server,/p\.keys=\{\};/);
  assert.match(server,/io\.to\(p\.id\)\.emit\('roundSpawn',\{x:p\.x,y:p\.y\}\)/);
  assert.match(server,/roomIO\(room\)\.emit\('leaderboard',getLeaderboard\(room\)\)/);
  assert.match(client,/socket\.on\('roundSpawn'/);
  assert.match(client,/lastKeyStr='';lastInputSentAt=0/);
});

test('rejected joins restore a clean menu state',()=>{
  assert.match(client,/socket\.on\('joinDenied',data=>\{\s*resetPlayButton\(\);\s*\/\/[\s\S]*?resetClientAfterRoomLeave\(\);/);
});

test('Play does not queue an account request while disconnected',()=>{
  assert.match(client,/function attemptPlay\(\)\{[\s\S]*?if\(!socket\.connected\)\{/);
  assert.match(client,/socket\.emit\('checkAccount',\{name,requestId:\+\+accountCheckRequestId\}\)/);
  assert.match(client,/data\.requestId!==accountCheckRequestId/);
});

test('sequenced clients cannot fall back to stale unsequenced input',()=>{
  assert.match(server,/p\.lastInputSeq>=0&&!Number\.isSafeInteger\(seq\)\) return/);
  assert.match(client,/angle:local\.angle,seq:\+\+inputSeq/);
});

test('damage and no-death challenge progress use real values',()=>{
  assert.match(server,/const actualDamage=Math\.min\(Math\.max\(0,p\.hp\),absorbed\.hpDamage\)/);
  assert.match(server,/killStreaks\.absorbDamage\(p,dmg,now\)/);
  assert.match(server,/bestNoDeathKills=Math\.max/);
  assert.match(server,/noDeathKills: p\.bestNoDeathKills \|\| p\.noDeathKills \|\| 0/);
});

test('repeatable premium products never render as permanently owned',()=>{
  assert.match(client,/const owned=!product\.repeatable&&/);
  assert.match(premium,/repeatable:product\.repeatable===true/);
});

test('round and room cleanup cannot leave stale render or update state',()=>{
  assert.match(client,/gameState=null;prevState=null;nextState=null;prevPlayersById=null;interpT=0/);
  assert.match(client,/for\(const state of \[gameState,prevState,nextState\]\)/);
  assert.match(server,/if \(room\.playerCountTimer\) \{\s*clearTimeout\(room\.playerCountTimer\)/);
  assert.match(server,/if \(!MAPS\[mapId\]\) mapId='arena'/);
});
