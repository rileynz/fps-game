'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

test('socket handlers normalize untrusted payloads before property access', () => {
  assert.doesNotMatch(server,/socket\.on\([^,\n]+,\s*\(\s*\{/);
  assert.match(server,/function asObject\(value\)/);
  assert.match(server,/asObject\(payload\)/);
});

test('protected accounts cannot mutate cosmetics without socket authentication', () => {
  assert.match(server,/protectedNameFailure\(name\)/);
  assert.match(server,/shopResult',\{ok:false,\.\.\.denied\}/);
});

test('Last Stand waits for grace respawns and ranks by survival', () => {
  assert.match(server,/now>=room\.lmsGraceEndsAt/);
  assert.match(server,/filter\(p=>!p\.eliminated\)/);
  assert.match(server,/room\.roundWinner\?\.id===p\.id/);
  assert.match(server,/eliminatedAt/);
});

test('round completion and persistence rollovers are idempotent and synchronous', () => {
  assert.match(server,/function startIntermission\(room\)\s*\{\s*if \(!room \|\| room\.roundState !== 'playing'\) return;/);
  assert.match(server,/function ensureCurrentDay\(\)/);
  assert.match(server,/function ensureCurrentWeek\(\)/);
  assert.match(server,/getPlayerDailyProgress\(name\)\s*\{\s*ensureCurrentDay\(\)/);
});

test('malformed joins are rejected instead of creating ghost players', () => {
  assert.match(server,/const safe=cleanPlayerName\(name\);\s*if \(!safe\) \{\s*socket\.emit\('joinDenied', \{ reason:'invalid_name' \}\)/);
});

test('client clears inputs and transient state on focus loss or disconnect', () => {
  assert.match(client,/window\.addEventListener\('blur',releaseAllInputs\)/);
  assert.match(client,/visibilitychange/);
  assert.match(client,/function clearTransientGameState\(\)/);
  assert.match(client,/socket\.on\('disconnect'.*clearTransientGameState\(\)/s);
});

test('player-controlled text is rendered with textContent', () => {
  assert.match(client,/nameEl\.textContent=String\(name\|\|'Player'\)/);
  assert.match(client,/msgEl\.textContent=' '\+String\(msg\|\|''\)/);
  assert.match(client,/playerName\.textContent=rowName/);
});
