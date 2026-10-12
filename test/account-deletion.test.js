'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const analytics=fs.readFileSync(path.join(root,'analytics.js'),'utf8');

test('account deletion requires an authenticated same-origin request and fresh credentials',()=>{
  assert.match(server,/app\.post\('\/api\/account\/delete',requireSameOrigin,requireAccountSession/);
  assert.match(server,/playerNameKey\(accountName\)!==key/);
  assert.match(server,/secureAccounts\.verifyPassword\(credential,rank\.passwordSalt,rank\.passwordHash\)/);
  assert.match(server,/const result=verifyPin\(rank\.name,String\(credential\|\|''\)\)/);
  assert.match(server,/reason:'credential_required'/);
});

test('deletion removes player-facing records and revokes every active session',()=>{
  assert.match(server,/delete dailyProgress\[key\]/);
  assert.match(server,/filter\(entry=>playerNameKey\(entry\.name\)!==key\)/);
  assert.match(server,/analytics\.deletePlayerData\(rank\.name\)/);
  assert.match(server,/collection\('daily_progress'\)\.deleteOne\(\{key\}\)/);
  assert.match(server,/collection\('account_sessions'\)\.deleteMany\(\{accountId\}\)/);
  assert.match(server,/collection\('ranks'\)\.deleteOne/);
  assert.match(server,/delete rankData\[key\]/);
  assert.match(server,/client\.data\.accountDeletionCleanup\(rank\.name\)/);
});

test('live account deletion cleanly leaves the match and clears socket authorization',()=>{
  assert.match(server,/socket\.data\.accountDeletionCleanup=name=>\{/);
  assert.match(server,/leaveCurrentRoom\('account_deleted'\)/);
  assert.match(server,/authedNameKey=null/);
  assert.match(server,/socket\.data\.accountSession=null/);
  assert.match(server,/socket\.emit\('accountDeleted',\{name\}\)/);
});

test('payment records remain for refunds but are detached from the deleted account',()=>{
  assert.match(server,/collection\('purchases'\)\.updateMany\(\s*\{accountId\},\s*\{\$set:\{accountDeletedAt:new Date\(\)\}\}/);
  assert.match(server,/if \(!rank\) \{[\s\S]*?status:'refunded'/);
});

test('analytics can purge both buffered and stored events for the deleted player',()=>{
  assert.match(analytics,/async function deletePlayerData\(name\)/);
  assert.match(analytics,/memBuffer\.splice\(index,1\)/);
  assert.match(analytics,/collection\('analytics_events'\)\.deleteMany\(\{name:target\}\)/);
  assert.match(analytics,/module\.exports = \{ init, logEvent, getSummary, deletePlayerData \}/);
});

test('the existing account panel contains a deliberate two-step deletion flow',()=>{
  assert.match(client,/id="menu-account-delete"/);
  assert.match(client,/id="account-delete-confirm"/);
  assert.match(client,/Paid items cannot be restored/);
  assert.match(client,/Type \$\{sessionAccount\.name\} exactly to confirm/);
  assert.match(client,/body:JSON\.stringify\(\{accountName:name,credential:/);
  assert.match(client,/apiRequest\('\/api\/account\/delete'/);
});

test('successful deletion clears local identity and handles server-forced cleanup',()=>{
  assert.match(client,/function handleDeletedAccount\(name\)/);
  assert.match(client,/resetClientAfterRoomLeave\(\)/);
  assert.match(client,/safeStorage\.remove\('arena_name'\)/);
  assert.match(client,/local\.name=''/);
  assert.match(client,/socket\.on\('accountDeleted'/);
});
