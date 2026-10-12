'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const ricochet=require('../ricochet');

const arena={worldW:500,worldH:400};
const wall=[{x:200,y:100,w:30,h:200}];

test('weapon bounce allowances preserve sniper identity',()=>{
  assert.equal(ricochet.ricochetsForWeapon('pistol'),1);
  assert.equal(ricochet.ricochetsForWeapon('smg'),1);
  assert.equal(ricochet.ricochetsForWeapon('shotgun'),1);
  assert.equal(ricochet.ricochetsForWeapon('sniper'),2);
});

test('a bullet reflects from a vertical obstacle without losing speed',()=>{
  const bullet={x:190,y:180,vx:12,vy:2,r:4,bouncesLeft:1,bounceCount:0};
  const before=Math.hypot(bullet.vx,bullet.vy);
  const result=ricochet.stepBullet(bullet,wall,arena);
  assert.equal(result.bounced,true);
  assert.equal(result.removed,false);
  assert.equal(bullet.bouncesLeft,0);
  assert.equal(bullet.bounceCount,1);
  assert.ok(bullet.vx<0);
  assert.ok(Math.abs(Math.hypot(bullet.vx,bullet.vy)-before)<1e-9);
});

test('a spent bullet is removed on its next wall contact',()=>{
  const bullet={x:190,y:180,vx:12,vy:0,r:4,bouncesLeft:0,bounceCount:1};
  const result=ricochet.stepBullet(bullet,wall,arena);
  assert.equal(result.removed,true);
  assert.equal(result.bounced,false);
});

test('a muzzle starting just inside a wall cannot tunnel through it',()=>{
  const bullet={x:198,y:180,vx:12,vy:0,r:4,bouncesLeft:1,bounceCount:0};
  const result=ricochet.stepBullet(bullet,wall,arena);
  assert.equal(result.bounced,true);
  assert.ok(bullet.vx<0);
  assert.ok(bullet.x<196);
});

test('arena boundaries also behave as readable ricochet walls',()=>{
  const bullet={x:493,y:80,vx:10,vy:0,r:4,bouncesLeft:1,bounceCount:0};
  const result=ricochet.stepBullet(bullet,[],arena);
  assert.equal(result.bounced,true);
  assert.equal(result.impact.type,'border');
  assert.ok(bullet.vx<0);
  assert.ok(bullet.x<496);
});

test('an exact arena corner is one bounce with a diagonal reflection',()=>{
  const bullet={x:493,y:393,vx:10,vy:10,r:4,bouncesLeft:1,bounceCount:0};
  const result=ricochet.stepBullet(bullet,[],arena);
  assert.equal(result.bounced,true);
  assert.equal(bullet.bouncesLeft,0);
  assert.equal(bullet.bounceCount,1);
  assert.ok(bullet.vx<0);
  assert.ok(bullet.vy<0);
});

test('kill point bonuses reward bank shots without changing damage',()=>{
  assert.equal(ricochet.killPointsForBounces(0),100);
  assert.equal(ricochet.killPointsForBounces(1),150);
  assert.equal(ricochet.killPointsForBounces(2),225);
  assert.equal(ricochet.killPointsForBounces(9),225);
});
