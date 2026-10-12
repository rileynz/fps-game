'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const challenges = require('../challenges');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('daily and weekly challenge pools are varied and never reference TDM', () => {
  assert.ok(challenges.DAILY_TYPES.length >= 20);
  assert.ok(challenges.WEEKLY_TYPES.length >= 12);
  const allTypes = [...challenges.DAILY_TYPES, ...challenges.WEEKLY_TYPES];
  assert.equal(allTypes.some(type => /tdm|team deathmatch/i.test(`${type.id} ${type.label}`)), false);
});

test('generated challenge sets are deterministic and category-diverse', () => {
  const first = challenges.generateDailyChallenges('2026-07-28');
  const second = challenges.generateDailyChallenges('2026-07-28');
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(item => item.type)).size, 3);
  assert.equal(new Set(first.map(item => item.category)).size, 3);

  const weekly = challenges.generateWeeklyChallenges('2026-W31');
  assert.equal(weekly.length, 3);
  assert.equal(new Set(weekly.map(item => item.category)).size, 3);
});

test('daily reroll is deterministic and replaces the selected challenge', () => {
  const current = challenges.generateDailyChallenges('2026-07-28');
  const replacement = challenges.generateRerolledChallenge(
    '2026-07-28', 'Riley', 1, current
  );
  assert.ok(replacement);
  assert.notEqual(replacement.type, current[1].type);
  assert.equal(current.some(item => item.type === replacement.type), false);
  assert.equal(replacement.points, current[1].points);
});

test('weapon, map, mode, and competitive progress use recorded round stats', () => {
  const memory = { modesPlayed: [], mapsPlayed: [] };
  const stats = {
    challengeKills: 3.5,
    challengeDamage: 425,
    challengeScore: 350,
    challengeWeaponKills: { sniper: 1.25 },
    mode: 'lms',
    mapId: 'castle',
    isLms: true,
    competitiveRound: true,
    won: true,
    placement: 1,
    deaths: 1,
  };
  challenges.updateChallengeMemory(memory, stats);

  assert.equal(challenges.progressChallenge(
    { type:'sniper_kills', weapon:'sniper', target:4 }, 0, stats, memory
  ), 1.25);
  assert.equal(challenges.progressChallenge(
    { type:'mode_variety', target:3 }, 0, stats, memory
  ), 1);
  assert.equal(challenges.progressChallenge(
    { type:'map_variety', target:5 }, 0, stats, memory
  ), 1);
  assert.equal(challenges.progressChallenge(
    { type:'lms_win', target:2 }, 0, stats, memory
  ), 1);
});

test('challenge progress resists bot farming while Ranked gives full bot SR', () => {
  assert.match(server, /botKills\|\|0\)\*0\.25/);
  assert.match(server, /botDamageDealt\|\|0\)\*0\.25/);
  assert.doesNotMatch(server, /noContest:true/);
  assert.match(server, /const rankedKills=Math\.max\(0,p\.kills\|\|0\)/);
  assert.match(server, /const sortedAll = allPlayers\.slice\(\)/);
  assert.match(server, /if \(changed\|\|anyNew\)/);
});

test('challenge UI stays behind one menu button with daily and weekly tabs', () => {
  assert.match(client, /id="challenge-tab-daily"/);
  assert.match(client, /id="challenge-tab-weekly"/);
  assert.match(client, /id="weekly-challenges-list"/);
  assert.match(client, /rerollDailyChallenge/);
});
