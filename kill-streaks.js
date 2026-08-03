'use strict';

const REWARDS=Object.freeze({
  3:Object.freeze({key:'recon',label:'Recon Pulse',durationMs:4000}),
  5:Object.freeze({key:'guard',label:'Guard',durationMs:12000,shield:25}),
  8:Object.freeze({key:'overdrive',label:'Overdrive',durationMs:8000}),
  12:Object.freeze({key:'arena_core',label:'Arena Core',durationMs:10000,shield:20}),
});

function ensure(player){
  if(!player||typeof player!=='object')return null;
  if(!Number.isFinite(player.killStreak))player.killStreak=0;
  if(!player.streakEarned||typeof player.streakEarned!=='object')player.streakEarned={};
  if(!Number.isFinite(player.streakRewardEndsAt))player.streakRewardEndsAt=0;
  if(!Number.isFinite(player.streakShield))player.streakShield=0;
  if(!Number.isFinite(player.streakShieldEndsAt))player.streakShieldEndsAt=0;
  return player;
}

function expire(player,now=Date.now()){
  if(!ensure(player))return;
  if(player.streakRewardEndsAt<=now){
    player.streakRewardKey=null;
    player.streakRewardEndsAt=0;
  }
  if(player.streakShieldEndsAt<=now){
    player.streakShield=0;
    player.streakShieldEndsAt=0;
  }
}

function reset(player){
  if(!ensure(player))return;
  player.killStreak=0;
  player.streakEarned={};
  player.streakRewardKey=null;
  player.streakRewardEndsAt=0;
  player.streakShield=0;
  player.streakShieldEndsAt=0;
}

function recordKill(player,{now=Date.now(),mode='ffa'}={}){
  if(!ensure(player))return null;
  expire(player,now);
  player.killStreak++;
  const reward=REWARDS[player.killStreak];
  if(!reward||player.streakEarned[player.killStreak])return null;
  player.streakEarned[player.killStreak]=true;

  // Last Man Standing keeps the information/recovery rewards, but avoids a
  // late-round speed snowball once respawns stop.
  const effective=(mode==='lms'&&reward.key==='overdrive')
    ?{key:'guard',label:'Guard',durationMs:8000,shield:15,lmsAdjusted:true}
    :(mode==='lms'&&reward.key==='arena_core')
      ?{key:'guard',label:'Guard',durationMs:8000,shield:20,lmsAdjusted:true}
      :reward;

  player.streakRewardKey=effective.key;
  player.streakRewardEndsAt=now+effective.durationMs;
  if(effective.shield){
    // A new reward replaces/refreshes the old shield; it never stacks.
    player.streakShield=Math.max(player.streakShield,effective.shield);
    player.streakShieldEndsAt=now+effective.durationMs;
  }
  return {...effective,streak:player.killStreak,endsAt:player.streakRewardEndsAt};
}

function movementMultiplier(player,now=Date.now()){
  expire(player,now);
  if(player?.streakRewardKey==='overdrive')return 1.10;
  if(player?.streakRewardKey==='arena_core')return 1.06;
  return 1;
}

function cooldownMultiplier(player,now=Date.now()){
  expire(player,now);
  if(player?.streakRewardKey==='overdrive')return 0.85;
  if(player?.streakRewardKey==='arena_core')return 0.80;
  return 1;
}

function absorbDamage(player,damage,now=Date.now()){
  expire(player,now);
  const incoming=Math.max(0,Number(damage)||0);
  const shieldDamage=Math.min(incoming,Math.max(0,player?.streakShield||0));
  if(player&&shieldDamage){
    player.streakShield=Math.max(0,player.streakShield-shieldDamage);
    if(player.streakShield===0)player.streakShieldEndsAt=0;
  }
  return {shieldDamage,hpDamage:incoming-shieldDamage,shield:player?.streakShield||0};
}

function publicState(player,now=Date.now()){
  expire(player,now);
  return {
    playerId:player?.id||null,
    streak:player?.killStreak||0,
    reward:player?.streakRewardKey||null,
    endsAt:player?.streakRewardEndsAt||0,
    shield:player?.streakShield||0,
  };
}

module.exports={REWARDS,ensure,expire,reset,recordKill,movementMultiplier,cooldownMultiplier,absorbDamage,publicState};
