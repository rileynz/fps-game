'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const streaks=require('../kill-streaks');

function player(){return{id:'p1'};}

test('streak rewards unlock once at 3, 5, 8, and 12 kills',()=>{
  const p=player();
  const rewards=[];
  for(let i=0;i<12;i++){
    const reward=streaks.recordKill(p,{now:1000+i,mode:'ffa'});
    if(reward)rewards.push(reward.key);
  }
  assert.deepEqual(rewards,['recon','guard','overdrive','arena_core']);
  assert.equal(p.killStreak,12);
});

test('shield absorbs damage without stacking beyond the active reward',()=>{
  const p=player();
  for(let i=0;i<5;i++)streaks.recordKill(p,{now:1000+i});
  assert.equal(p.streakShield,25);
  assert.deepEqual(streaks.absorbDamage(p,10,2000),{shieldDamage:10,hpDamage:0,shield:15});
  assert.deepEqual(streaks.absorbDamage(p,25,2001),{shieldDamage:15,hpDamage:10,shield:0});
});

test('overdrive is server-authoritative and Last Man Standing avoids speed snowballing',()=>{
  const ffa=player();
  const lms=player();
  for(let i=0;i<8;i++){
    streaks.recordKill(ffa,{now:1000+i,mode:'ffa'});
    streaks.recordKill(lms,{now:1000+i,mode:'lms'});
  }
  assert.equal(streaks.movementMultiplier(ffa,2000),1.1);
  assert.equal(streaks.cooldownMultiplier(ffa,2000),0.85);
  assert.equal(streaks.movementMultiplier(lms,2000),1);
  assert.equal(lms.streakRewardKey,'guard');
});

test('death reset removes all streak advantages',()=>{
  const p=player();
  for(let i=0;i<8;i++)streaks.recordKill(p,{now:1000+i});
  streaks.reset(p);
  assert.deepEqual(streaks.publicState(p,2000),{playerId:'p1',streak:0,reward:null,endsAt:0,shield:0});
  assert.equal(streaks.movementMultiplier(p,2000),1);
});
