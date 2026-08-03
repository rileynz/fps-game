'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {
  SocialSystem,
  ensureSocial,
  MAX_RECENT_PLAYERS,
  RECENT_PLAYER_TTL_MS,
}=require('../social-system');

function fixture(){
  const accounts={
    nova:{name:'nova'},
    ryze:{name:'ryze'},
    echo:{name:'echo'},
  };
  const saves=[];
  let byte=0;
  const system=new SocialSystem({
    getAccount:key=>accounts[key]||null,
    saveAccount:async key=>saves.push(key),
    randomBytes:size=>Buffer.alloc(size,byte++),
  });
  return{accounts,saves,system};
}

test('friend requests are reciprocal, persistent, and removable',async()=>{
  const {accounts,system}=fixture();
  assert.deepEqual(await system.sendRequest('nova','ryze'),{ok:true});
  assert.deepEqual(ensureSocial(accounts.nova).outgoing,['ryze']);
  assert.deepEqual(ensureSocial(accounts.ryze).incoming,['nova']);

  assert.deepEqual(await system.acceptRequest('ryze','nova'),{ok:true});
  assert.deepEqual(ensureSocial(accounts.nova).friends,['ryze']);
  assert.deepEqual(ensureSocial(accounts.ryze).friends,['nova']);
  assert.deepEqual(ensureSocial(accounts.nova).outgoing,[]);

  assert.deepEqual(await system.removeFriend('nova','ryze'),{ok:true});
  assert.deepEqual(ensureSocial(accounts.nova).friends,[]);
  assert.deepEqual(ensureSocial(accounts.ryze).friends,[]);
});

test('blocking removes every relationship in both directions',async()=>{
  const {accounts,system}=fixture();
  await system.recordRecentPlayers(['nova','ryze'],'ffa',Date.now());
  await system.sendRequest('nova','ryze');
  await system.acceptRequest('ryze','nova');
  await system.block('nova','ryze');
  assert.deepEqual(ensureSocial(accounts.nova).blocked,['ryze']);
  assert.deepEqual(ensureSocial(accounts.nova).friends,[]);
  assert.deepEqual(ensureSocial(accounts.ryze).friends,[]);
  assert.deepEqual(ensureSocial(accounts.nova).recentPlayers,[]);
  assert.deepEqual(ensureSocial(accounts.ryze).recentPlayers,[]);
  assert.deepEqual(await system.sendRequest('ryze','nova'),{ok:false,reason:'blocked'});
});

test('account deletion purges references from other accounts',async()=>{
  const {accounts,system}=fixture();
  await system.recordRecentPlayers(['nova','ryze','echo'],'ranked',Date.now());
  await system.sendRequest('nova','ryze');
  await system.acceptRequest('ryze','nova');
  await system.sendRequest('echo','nova');
  await system.deleteAccount('nova');
  assert.deepEqual(ensureSocial(accounts.ryze).friends,[]);
  assert.deepEqual(ensureSocial(accounts.echo).outgoing,[]);
  assert.equal(ensureSocial(accounts.ryze).recentPlayers.some(item=>item.key==='nova'),false);
  assert.equal(ensureSocial(accounts.echo).recentPlayers.some(item=>item.key==='nova'),false);
});

test('recent players are bounded, deduplicated, counted, and expire',async()=>{
  const {accounts,system}=fixture();
  const now=1_900_000_000_000;
  assert.equal(MAX_RECENT_PLAYERS,20);
  assert.deepEqual(
    await system.recordRecentPlayers(['nova','ryze','echo'],'lms',now),
    {ok:true,updated:3},
  );
  assert.deepEqual(
    ensureSocial(accounts.nova,now).recentPlayers.map(item=>item.key),
    ['echo','ryze'],
  );
  await system.recordRecentPlayers(['nova','ryze'],'ranked',now+1000);
  const recent=ensureSocial(accounts.nova,now+1000).recentPlayers;
  assert.deepEqual(recent.map(item=>item.key),['ryze','echo']);
  assert.equal(recent[0].matches,2);
  assert.equal(recent[0].mode,'ranked');
  assert.deepEqual(ensureSocial(accounts.nova,now+RECENT_PLAYER_TTL_MS+1001).recentPlayers,[]);
});

test('parties support four members, leadership, privacy, and cleanup',()=>{
  const {system}=fixture();
  const leader={id:'account:nova',socketId:'s1',accountKey:'nova',name:'nova',platform:'web'};
  const created=system.createParty(leader);
  assert.equal(created.ok,true);
  assert.match(created.party.code,/^[A-HJ-NP-Z2-9]{6}$/);
  const code=created.party.code;

  for(let index=2;index<=4;index++){
    const result=system.joinParty({
      id:`guest:s${index}`,socketId:`s${index}`,name:`p${index}`,platform:'crazygames',
    },code);
    assert.equal(result.ok,true);
  }
  assert.deepEqual(
    system.joinParty({id:'guest:s5',socketId:'s5',name:'p5',platform:'web'},code),
    {ok:false,reason:'party_full'},
  );
  assert.equal(system.setOpen('account:nova',false).party.open,false);
  assert.deepEqual(
    system.joinParty({id:'guest:s6',socketId:'s6',name:'p6',platform:'web'},code),
    {ok:false,reason:'party_private'},
  );
  assert.equal(
    system.joinParty(
      {id:'guest:s6',socketId:'s6',name:'p6',platform:'web'},
      code,
      {invited:true},
    ).reason,
    'party_full',
  );
  assert.equal(system.promote('account:nova','guest:s2').ok,true);
  assert.equal(created.party.leaderId,'guest:s2');
  system.leaveParty('guest:s2');
  assert.equal(created.party.leaderId,'account:nova');
});
