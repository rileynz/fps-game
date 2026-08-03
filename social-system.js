'use strict';

const crypto=require('crypto');

const MAX_FRIENDS=100;
const MAX_PENDING=30;
const MAX_BLOCKED=100;
const MAX_PARTY_SIZE=4;
const MAX_RECENT_PLAYERS=20;
const RECENT_PLAYER_TTL_MS=7*24*60*60*1000;
const PARTY_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function uniqueKeys(value,limit){
  if(!Array.isArray(value))return[];
  const result=[];
  const seen=new Set();
  for(const raw of value){
    const key=String(raw||'').trim().toLowerCase();
    if(!key||seen.has(key))continue;
    seen.add(key);
    result.push(key);
    if(result.length>=limit)break;
  }
  return result;
}

function cleanRecentPlayers(value,now=Date.now()){
  if(!Array.isArray(value))return[];
  const result=[];
  const seen=new Set();
  const oldest=now-RECENT_PLAYER_TTL_MS;
  for(const raw of value){
    if(!raw||typeof raw!=='object')continue;
    const key=String(raw.key||'').trim().toLowerCase().slice(0,32);
    const playedAt=Math.round(Number(raw.playedAt));
    if(!key||seen.has(key)||!Number.isFinite(playedAt)||playedAt<oldest)continue;
    seen.add(key);
    result.push({
      key,
      mode:['ffa','ranked','lms'].includes(raw.mode)?raw.mode:'ffa',
      playedAt:Math.min(now,playedAt),
      matches:Math.max(1,Math.min(999,Math.round(Number(raw.matches)||1))),
    });
    if(result.length>=MAX_RECENT_PLAYERS)break;
  }
  return result;
}

function ensureSocial(account,now=Date.now()){
  if(!account||typeof account!=='object')return null;
  const source=account.social&&typeof account.social==='object'?account.social:{};
  const social={
    friends:uniqueKeys(source.friends,MAX_FRIENDS),
    incoming:uniqueKeys(source.incoming,MAX_PENDING),
    outgoing:uniqueKeys(source.outgoing,MAX_PENDING),
    blocked:uniqueKeys(source.blocked,MAX_BLOCKED),
    joinPolicy:source.joinPolicy==='invite'?'invite':'friends',
    appearOffline:source.appearOffline===true,
    recentPlayers:cleanRecentPlayers(source.recentPlayers,now),
  };
  account.social=social;
  return social;
}

function removeKey(list,key){
  const index=list.indexOf(key);
  if(index<0)return false;
  list.splice(index,1);
  return true;
}

function cleanMember(member){
  if(!member||typeof member!=='object')return null;
  const id=String(member.id||'').slice(0,100);
  const socketId=String(member.socketId||'').slice(0,100);
  const name=String(member.name||'Player').trim().slice(0,16)||'Player';
  if(!id||!socketId)return null;
  return {
    id,
    socketId,
    name,
    accountKey:member.accountKey?String(member.accountKey).toLowerCase():null,
    platform:String(member.platform||'web').slice(0,24),
  };
}

class SocialSystem{
  constructor({
    getAccount,
    saveAccount=()=>{},
    randomBytes=size=>crypto.randomBytes(size),
  }={}){
    this.getAccount=typeof getAccount==='function'?getAccount:()=>null;
    this.saveAccount=typeof saveAccount==='function'?saveAccount:()=>{};
    this.randomBytes=randomBytes;
    this.parties=new Map();
    this.memberParty=new Map();
  }

  social(key,now=Date.now()){
    const account=this.getAccount(key);
    return account?ensureSocial(account,now):null;
  }

  async saveKeys(...keys){
    const unique=[...new Set(keys.filter(Boolean))];
    await Promise.all(unique.map(key=>this.saveAccount(key)));
  }

  async sendRequest(fromKey,toKey){
    if(!fromKey||!toKey||fromKey===toKey)return{ok:false,reason:'invalid_target'};
    const from=this.social(fromKey);
    const to=this.social(toKey);
    if(!from||!to)return{ok:false,reason:'not_found'};
    if(from.blocked.includes(toKey)||to.blocked.includes(fromKey))return{ok:false,reason:'blocked'};
    if(from.friends.includes(toKey))return{ok:false,reason:'already_friends'};
    if(from.outgoing.includes(toKey))return{ok:true,alreadyPending:true};
    if(from.incoming.includes(toKey)){
      return this.acceptRequest(fromKey,toKey);
    }
    if(from.outgoing.length>=MAX_PENDING||to.incoming.length>=MAX_PENDING){
      return{ok:false,reason:'request_limit'};
    }
    from.outgoing.push(toKey);
    to.incoming.push(fromKey);
    await this.saveKeys(fromKey,toKey);
    return{ok:true};
  }

  async acceptRequest(key,fromKey){
    const social=this.social(key);
    const from=this.social(fromKey);
    if(!social||!from)return{ok:false,reason:'not_found'};
    if(!social.incoming.includes(fromKey)||!from.outgoing.includes(key)){
      return{ok:false,reason:'request_not_found'};
    }
    if(social.blocked.includes(fromKey)||from.blocked.includes(key)){
      return{ok:false,reason:'blocked'};
    }
    if(social.friends.length>=MAX_FRIENDS||from.friends.length>=MAX_FRIENDS){
      return{ok:false,reason:'friend_limit'};
    }
    removeKey(social.incoming,fromKey);
    removeKey(from.outgoing,key);
    if(!social.friends.includes(fromKey))social.friends.push(fromKey);
    if(!from.friends.includes(key))from.friends.push(key);
    await this.saveKeys(key,fromKey);
    return{ok:true};
  }

  async declineRequest(key,fromKey){
    const social=this.social(key);
    const from=this.social(fromKey);
    if(!social||!from)return{ok:false,reason:'not_found'};
    const changed=removeKey(social.incoming,fromKey)|removeKey(from.outgoing,key);
    if(changed)await this.saveKeys(key,fromKey);
    return{ok:true};
  }

  async cancelRequest(key,toKey){
    const social=this.social(key);
    const target=this.social(toKey);
    if(!social||!target)return{ok:false,reason:'not_found'};
    const changed=removeKey(social.outgoing,toKey)|removeKey(target.incoming,key);
    if(changed)await this.saveKeys(key,toKey);
    return{ok:true};
  }

  async removeFriend(key,friendKey){
    const social=this.social(key);
    const friend=this.social(friendKey);
    if(!social)return{ok:false,reason:'not_found'};
    const changed=removeKey(social.friends,friendKey);
    if(friend)removeKey(friend.friends,key);
    if(changed)await this.saveKeys(key,friendKey);
    return{ok:true};
  }

  async block(key,targetKey){
    if(!key||!targetKey||key===targetKey)return{ok:false,reason:'invalid_target'};
    const social=this.social(key);
    const target=this.social(targetKey);
    if(!social||!target)return{ok:false,reason:'not_found'};
    if(!social.blocked.includes(targetKey)){
      if(social.blocked.length>=MAX_BLOCKED)return{ok:false,reason:'block_limit'};
      social.blocked.push(targetKey);
    }
    for(const list of [social.friends,social.incoming,social.outgoing])removeKey(list,targetKey);
    for(const list of [target.friends,target.incoming,target.outgoing])removeKey(list,key);
    social.recentPlayers=social.recentPlayers.filter(item=>item.key!==targetKey);
    target.recentPlayers=target.recentPlayers.filter(item=>item.key!==key);
    await this.saveKeys(key,targetKey);
    return{ok:true};
  }

  async unblock(key,targetKey){
    const social=this.social(key);
    if(!social)return{ok:false,reason:'not_found'};
    if(removeKey(social.blocked,targetKey))await this.saveKeys(key);
    return{ok:true};
  }

  async updateSettings(key,settings){
    const social=this.social(key);
    if(!social)return{ok:false,reason:'not_found'};
    if(settings&&Object.prototype.hasOwnProperty.call(settings,'appearOffline')){
      social.appearOffline=settings.appearOffline===true;
    }
    if(settings&&Object.prototype.hasOwnProperty.call(settings,'joinPolicy')){
      social.joinPolicy=settings.joinPolicy==='invite'?'invite':'friends';
    }
    await this.saveKeys(key);
    return{ok:true};
  }

  async recordRecentPlayers(playerKeys,mode,playedAt=Date.now()){
    const keys=uniqueKeys(playerKeys,MAX_RECENT_PLAYERS+1)
      .filter(key=>this.getAccount(key));
    if(keys.length<2)return{ok:true,updated:0};
    const safeMode=['ffa','ranked','lms'].includes(mode)?mode:'ffa';
    let updated=0;
    for(const ownerKey of keys){
      const social=this.social(ownerKey,playedAt);
      if(!social)continue;
      for(const targetKey of keys){
        if(targetKey===ownerKey)continue;
        const existing=social.recentPlayers.find(item=>item.key===targetKey);
        social.recentPlayers=social.recentPlayers.filter(item=>item.key!==targetKey);
        social.recentPlayers.unshift({
          key:targetKey,
          mode:safeMode,
          playedAt,
          matches:Math.min(999,(existing?.matches||0)+1),
        });
      }
      social.recentPlayers=cleanRecentPlayers(social.recentPlayers,playedAt);
      updated++;
    }
    await this.saveKeys(...keys);
    return{ok:true,updated};
  }

  async deleteAccount(key){
    const account=this.getAccount(key);
    const social=account?ensureSocial(account):null;
    if(!social)return;
    const related=new Set([
      ...social.friends,...social.incoming,...social.outgoing,...social.blocked,
      ...social.recentPlayers.map(item=>item.key),
    ]);
    for(const otherKey of related){
      const other=this.social(otherKey);
      if(!other)continue;
      for(const list of [other.friends,other.incoming,other.outgoing,other.blocked])removeKey(list,key);
      other.recentPlayers=other.recentPlayers.filter(item=>item.key!==key);
      await this.saveAccount(otherKey);
    }
  }

  newPartyCode(){
    for(let attempt=0;attempt<50;attempt++){
      const bytes=this.randomBytes(6);
      let code='';
      for(let index=0;index<6;index++)code+=PARTY_ALPHABET[bytes[index]%PARTY_ALPHABET.length];
      if(!this.parties.has(code))return code;
    }
    throw new Error('party_code_exhausted');
  }

  createParty(member){
    const safe=cleanMember(member);
    if(!safe)return{ok:false,reason:'invalid_member'};
    this.leaveParty(safe.id);
    const code=this.newPartyCode();
    const party={
      code,
      leaderId:safe.id,
      members:[safe],
      open:true,
      mode:'ffa',
      gameRoomId:null,
      createdAt:Date.now(),
    };
    this.parties.set(code,party);
    this.memberParty.set(safe.id,code);
    return{ok:true,party};
  }

  getPartyByMember(memberId){
    const code=this.memberParty.get(memberId);
    return code?this.parties.get(code)||null:null;
  }

  joinParty(member,rawCode,{invited=false}={}){
    const safe=cleanMember(member);
    const code=String(rawCode||'').trim().toUpperCase();
    const party=this.parties.get(code);
    if(!safe||!party)return{ok:false,reason:'party_not_found'};
    if(!party.open&&!invited)return{ok:false,reason:'party_private'};
    if(party.members.length>=MAX_PARTY_SIZE)return{ok:false,reason:'party_full'};
    if(party.members.some(item=>item.id===safe.id))return{ok:true,party};
    this.leaveParty(safe.id);
    party.members.push(safe);
    this.memberParty.set(safe.id,code);
    return{ok:true,party};
  }

  leaveParty(memberId){
    const party=this.getPartyByMember(memberId);
    if(!party)return null;
    party.members=party.members.filter(member=>member.id!==memberId);
    this.memberParty.delete(memberId);
    if(party.members.length===0){
      this.parties.delete(party.code);
      return null;
    }
    if(party.leaderId===memberId)party.leaderId=party.members[0].id;
    return party;
  }

  kick(leaderId,memberId){
    const party=this.getPartyByMember(leaderId);
    if(!party||party.leaderId!==leaderId)return{ok:false,reason:'not_leader'};
    if(memberId===leaderId)return{ok:false,reason:'invalid_target'};
    if(!party.members.some(member=>member.id===memberId))return{ok:false,reason:'not_in_party'};
    this.leaveParty(memberId);
    return{ok:true,party};
  }

  promote(leaderId,memberId){
    const party=this.getPartyByMember(leaderId);
    if(!party||party.leaderId!==leaderId)return{ok:false,reason:'not_leader'};
    if(!party.members.some(member=>member.id===memberId))return{ok:false,reason:'not_in_party'};
    party.leaderId=memberId;
    return{ok:true,party};
  }

  setOpen(leaderId,open){
    const party=this.getPartyByMember(leaderId);
    if(!party||party.leaderId!==leaderId)return{ok:false,reason:'not_leader'};
    party.open=open===true;
    return{ok:true,party};
  }
}

module.exports={
  SocialSystem,
  ensureSocial,
  MAX_FRIENDS,
  MAX_PENDING,
  MAX_BLOCKED,
  MAX_PARTY_SIZE,
  MAX_RECENT_PLAYERS,
  RECENT_PLAYER_TTL_MS,
};
