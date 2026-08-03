'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const adapter=fs.readFileSync(path.join(root,'platform','crazygames','crazygames-adapter.js'),'utf8');

test('professional social and unified match-menu surfaces are present',()=>{
  for(const id of [
    'social-menu-btn','social-panel','party-members','friends-list',
    'game-menu-btn','game-menu-panel','game-menu-resume','game-menu-leave',
  ])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Match continues while this menu is open/i);
  assert.match(html,/there are no private messages/i);
});

test('HUD keeps gameplay information while moving utility controls into the menu',()=>{
  assert.match(html,/id="pb-online-val"[^>]*>0 online/);
  assert.match(html,/id="pb-online-val"/);
  assert.match(html,/class="pb-item" hidden/);
  assert.match(html,/id="mute-btn"[^>]*class="game-menu-action"|class="game-menu-action" id="mute-btn"/);
  assert.match(html,/id="chat-open-hint" hidden/);
  for(const id of ['round-timer','lb','hud-bl','mm-wrap','kf']){
    assert.match(html,new RegExp(`id="${id}"`));
  }
});

test('server exposes account-backed social actions and same-room party launches',()=>{
  for(const event of [
    'getSocial','socialAction','partyCreate','partyJoin','partyInvite',
    'partyLaunch','partyLeave','partyKick','partyPromote',
  ])assert.match(server,new RegExp(`socket\\.on\\('${event}'`));
  assert.match(server,/room=findPartyRoom\(party,mode\)/);
  assert.match(server,/const PUBLIC_GAME_MODES = new Set\(\['ffa', 'ranked', 'lms'\]\)/);
});

test('CrazyGames adapter reports rooms and handles portal invite links',()=>{
  assert.match(adapter,/game\.updateRoom/);
  assert.match(adapter,/game\.leftRoom/);
  assert.match(adapter,/game\.inviteLink/);
  assert.match(adapter,/game\.addJoinRoomListener/);
  assert.match(adapter,/game\.isInstantMultiplayer/);
  assert.match(adapter,/game\.showInviteButton/);
  assert.match(adapter,/game\.hideInviteButton/);
  assert.match(html,/function startCrazyGamesInstantMultiplayer\(/);
});

test('Social Hub uses Arena.io branding and compact action dropdowns',()=>{
  assert.match(html,/Arena\.io \/\/ Party Link/);
  assert.match(html,/id="social-title">Squad Hub</);
  assert.match(html,/class="social-tab-index">01</);
  assert.match(html,/class="social-request-group"/);
  assert.match(html,/function makeSocialDropdown\(/);
  assert.match(html,/ENTER EXACT ARENA\.IO NAME/);
  assert.match(html,/id="party-code" class="solo">SOLO QUEUE</);
  assert.doesNotMatch(html,/Arena network/);
  assert.doesNotMatch(html,/placeholder="Exact Arena player name"/);
});

test('Recent Players is Arena-styled, bounded, and fetched outside realtime gameplay',()=>{
  for(const id of [
    'friends-channel-count','recent-player-count','recent-players-list',
  ])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Arena\.io \/\/ Match History/);
  assert.match(html,/function renderRecentPlayers\(/);
  assert.match(html,/players\.slice\(0,20\)/);
  assert.match(server,/socialSystem\.recordRecentPlayers\(recentAccountKeys,room\.mode\)/);
  assert.match(server,/p\.accountKey=authedNameKey===playerNameKey\(safe\)/);
  assert.match(server,/socket\.emit\('recentPlayers',key\?recentPlayersSnapshot\(key\)/);
  assert.doesNotMatch(server,/roomIO\(room\)\.emit\('recentPlayers'/);
});
