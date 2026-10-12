'use strict';

// The compact realtime protocol intentionally uses small arrays rather than
// repeating property names 20 times per second. Static player information
// (name, colour, team and cosmetics) already lives in the reliable roster.
const WEAPON_TO_CODE = Object.freeze({
  pistol:0,
  shotgun:1,
  smg:2,
  sniper:3,
});

const CODE_TO_WEAPON = Object.freeze([
  'pistol',
  'shotgun',
  'smg',
  'sniper',
]);

const BINARY_PLAYER_PACKET = 1;
const BINARY_BULLET_PACKET = 2;
const BINARY_STATE_PACKET = 4;
const BINARY_PLAYER_BASE_BYTES = 10;
const BINARY_SELF_EXTRA_BYTES = 4;
const BINARY_V4_SELF_EXTRA_BYTES = 8;
const BINARY_BULLET_BYTES = 15;
const BINARY_STATE_HEADER_BYTES = 12;

function clampInteger(value,min,max) {
  const number=Math.round(Number(value)||0);
  return Math.max(min,Math.min(max,number));
}

function encodePlayer(player, selfId) {
  const row = [
    player.id,
    player.x | 0,
    player.y | 0,
    Math.round(player.angle * 1000),
    Math.max(0, Math.round(player.hp)),
    (player.alive ? 1 : 0) | (player.eliminated ? 2 : 0),
  ];
  if (player.id === selfId) {
    row.push(player.kills | 0, player.score | 0);
  }
  return row;
}

function encodeBullet(bullet, includeMetadata) {
  const row = [bullet.id, bullet.x | 0, bullet.y | 0];
  if (includeMetadata) {
    row.push(
      Math.round(bullet.vx * 1000),
      Math.round(bullet.vy * 1000),
      bullet.owner,
      WEAPON_TO_CODE[bullet.wpn] ?? 0,
    );
  }
  return row;
}

function encodeZone(zone) {
  if (!zone) return null;
  return [
    zone.cx | 0,
    zone.cy | 0,
    zone.r | 0,
    zone.nextCx | 0,
    zone.nextCy | 0,
    zone.nextR | 0,
    Number.isFinite(zone.phaseEndsAt) ? zone.phaseEndsAt : 0,
    zone.shrinking ? 1 : 0,
    zone.complete ? 1 : 0,
  ];
}

function encodeRoomMeta(options) {
  const {
    seq,
    roundState,
    endsAt,
    teamKills,
    zone,
    graceEndsAt,
    lmsAlive,
    isSpectator,
  } = options;
  return [
    seq >>> 0,
    roundState === 'playing' ? 0 : 1,
    Number.isFinite(endsAt) ? endsAt : 0,
    teamKills ? teamKills.red | 0 : 0,
    teamKills ? teamKills.blue | 0 : 0,
    encodeZone(zone),
    Number.isFinite(graceEndsAt) ? graceEndsAt : 0,
    Number.isFinite(lmsAlive) ? lmsAlive : -1,
    isSpectator ? 1 : 0,
  ];
}

// Protocol v3 uses binary snapshots. Movement remains a full, absolute 20 Hz
// state, so a dropped volatile packet cannot corrupt a later packet. Long
// Socket.IO IDs remain in the reliable roster and are replaced here by a
// room-local uint16 netId.
function encodePlayerPacket(seq,players,selfId) {
  const rows=Array.isArray(players)?players:[];
  let size=7;
  for(const player of rows)size+=BINARY_PLAYER_BASE_BYTES+(player.id===selfId?BINARY_SELF_EXTRA_BYTES:0);
  const packet=Buffer.allocUnsafe(size);
  packet.writeUInt8(BINARY_PLAYER_PACKET,0);
  packet.writeUInt32LE((Number(seq)||0)>>>0,1);
  packet.writeUInt16LE(Math.min(65535,rows.length),5);
  let offset=7;
  for(const player of rows){
    const isSelf=player.id===selfId;
    const flags=(player.alive?1:0)|(player.eliminated?2:0)|(isSelf?4:0);
    packet.writeUInt16LE(clampInteger(player.netId,0,65535),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(player.x,0,65535),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(player.y,0,65535),offset);offset+=2;
    packet.writeInt16LE(clampInteger((Number(player.angle)||0)/Math.PI*32767,-32767,32767),offset);offset+=2;
    packet.writeUInt8(clampInteger(player.hp,0,255),offset++);
    packet.writeUInt8(flags,offset++);
    if(isSelf){
      packet.writeUInt16LE(clampInteger(player.kills,0,65535),offset);offset+=2;
      packet.writeUInt16LE(clampInteger(player.score,0,65535),offset);offset+=2;
    }
  }
  return packet;
}

// Bullet corrections are independent from player movement. The client
// extrapolates fixed projectile velocity every render frame; this authoritative
// packet corrects the result without requiring projectile positions at 20 Hz.
function encodeBulletPacket(seq,bullets,playersById) {
  const rows=Array.isArray(bullets)?bullets:[];
  const packet=Buffer.allocUnsafe(7+Math.min(65535,rows.length)*BINARY_BULLET_BYTES);
  packet.writeUInt8(BINARY_BULLET_PACKET,0);
  packet.writeUInt32LE((Number(seq)||0)>>>0,1);
  packet.writeUInt16LE(Math.min(65535,rows.length),5);
  let offset=7;
  for(const bullet of rows.slice(0,65535)){
    const owner=playersById&&playersById[bullet.owner];
    packet.writeUInt32LE((Number(bullet.id)||0)>>>0,offset);offset+=4;
    packet.writeUInt16LE(clampInteger(bullet.x,0,65535),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(bullet.y,0,65535),offset);offset+=2;
    packet.writeInt16LE(clampInteger((Number(bullet.vx)||0)*256,-32768,32767),offset);offset+=2;
    packet.writeInt16LE(clampInteger((Number(bullet.vy)||0)*256,-32768,32767),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(owner?.netId,0,65535),offset);offset+=2;
    packet.writeUInt8(WEAPON_TO_CODE[bullet.wpn]??0,offset++);
  }
  return packet;
}

// Protocol v4 combines players and the current bullet delta into one binary
// Socket.IO attachment. This keeps active combat at 20 Hz while avoiding a
// separate reliable event for every projectile spawn and removal.
//
// bulletMode:
//   0 = no bullet changes in this packet
//   1 = full visible bullet snapshot (replaces the client's current set)
//   2 = delta (adds bullet rows and removes goneIds)
function encodeStatePacket(seq,players,selfId,{
  bulletMode=0,
  bullets=[],
  goneIds=[],
  playersById=null,
}={}) {
  const playerRows=(Array.isArray(players)?players:[]).slice(0,65535);
  const mode=clampInteger(bulletMode,0,2);
  const bulletRows=(mode&&Array.isArray(bullets)?bullets:[]).slice(0,65535);
  const goneRows=(mode===2&&Array.isArray(goneIds)?goneIds:[]).slice(0,65535);
  let size=BINARY_STATE_HEADER_BYTES;
  for(const player of playerRows){
    size+=BINARY_PLAYER_BASE_BYTES+(player.id===selfId?BINARY_V4_SELF_EXTRA_BYTES:0);
  }
  size+=bulletRows.length*BINARY_BULLET_BYTES+goneRows.length*4;
  const packet=Buffer.allocUnsafe(size);
  packet.writeUInt8(BINARY_STATE_PACKET,0);
  packet.writeUInt32LE((Number(seq)||0)>>>0,1);
  packet.writeUInt16LE(playerRows.length,5);
  packet.writeUInt8(mode,7);
  packet.writeUInt16LE(bulletRows.length,8);
  packet.writeUInt16LE(goneRows.length,10);
  let offset=BINARY_STATE_HEADER_BYTES;
  for(const player of playerRows){
    const isSelf=player.id===selfId;
    const flags=(player.alive?1:0)|(player.eliminated?2:0)|(isSelf?4:0);
    packet.writeUInt16LE(clampInteger(player.netId,0,65535),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(player.x,0,65535),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(player.y,0,65535),offset);offset+=2;
    packet.writeInt16LE(clampInteger((Number(player.angle)||0)/Math.PI*32767,-32767,32767),offset);offset+=2;
    packet.writeUInt8(clampInteger(player.hp,0,255),offset++);
    packet.writeUInt8(flags,offset++);
    if(isSelf){
      packet.writeUInt16LE(clampInteger(player.kills,0,65535),offset);offset+=2;
      packet.writeUInt16LE(clampInteger(player.score,0,65535),offset);offset+=2;
      packet.writeUInt32LE(clampInteger(player.lastInputSeq,0,0xffffffff),offset);offset+=4;
    }
  }
  for(const bullet of bulletRows){
    const owner=playersById&&playersById[bullet.owner];
    packet.writeUInt32LE((Number(bullet.id)||0)>>>0,offset);offset+=4;
    packet.writeUInt16LE(clampInteger(bullet.x,0,65535),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(bullet.y,0,65535),offset);offset+=2;
    packet.writeInt16LE(clampInteger((Number(bullet.vx)||0)*256,-32768,32767),offset);offset+=2;
    packet.writeInt16LE(clampInteger((Number(bullet.vy)||0)*256,-32768,32767),offset);offset+=2;
    packet.writeUInt16LE(clampInteger(owner?.netId,0,65535),offset);offset+=2;
    packet.writeUInt8(WEAPON_TO_CODE[bullet.wpn]??0,offset++);
  }
  for(const id of goneRows){
    packet.writeUInt32LE((Number(id)||0)>>>0,offset);offset+=4;
  }
  return packet;
}

module.exports = {
  WEAPON_TO_CODE,
  CODE_TO_WEAPON,
  BINARY_PLAYER_PACKET,
  BINARY_BULLET_PACKET,
  BINARY_STATE_PACKET,
  BINARY_PLAYER_BASE_BYTES,
  BINARY_SELF_EXTRA_BYTES,
  BINARY_V4_SELF_EXTRA_BYTES,
  BINARY_BULLET_BYTES,
  BINARY_STATE_HEADER_BYTES,
  encodePlayer,
  encodeBullet,
  encodeZone,
  encodeRoomMeta,
  encodePlayerPacket,
  encodeBulletPacket,
  encodeStatePacket,
};
