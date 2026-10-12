'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const botNames = require(path.join(root, 'bot-names'));
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('bot names use the lowercase arena naming style', () => {
  assert.ok(botNames.length >= 60);
  assert.equal(new Set(botNames).size, botNames.length);
  for (const name of botNames) {
    assert.match(name, /^[a-z][a-z0-9_]{2,15}$/);
    assert.doesNotMatch(name, /pixel|kiwi|toast|panda|mango|comet|otter|waffle|soda|moth/);
  }
});

test('the first join receives bots in its initial roster and leaderboard', () => {
  const start = server.indexOf("socket.on('join'");
  const end = server.indexOf("socket.on('input'", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const joinHandler = server.slice(start, end);
  const syncAt = joinHandler.indexOf('syncBotPopulation(room)');
  assert.ok(syncAt >= 0);
  assert.ok(syncAt < joinHandler.indexOf('socket.join'));
  assert.ok(syncAt < joinHandler.indexOf("socket.emit('init'"));
  assert.match(joinHandler, /leaderboard:getLeaderboard\(room\)/);
  assert.match(joinHandler, /roster:room\.roster/);
});

test('TDM remains outside public matchmaking', () => {
  assert.match(server, /PUBLIC_GAME_MODES = new Set\(\['ffa', 'ranked', 'lms'\]\)/);
  assert.doesNotMatch(server, /PUBLIC_GAME_MODES = new Set\([^)]*tdm/);
});
