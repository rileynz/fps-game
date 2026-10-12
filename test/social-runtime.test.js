'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const {io}=require('socket.io-client');

const root=path.join(__dirname,'..');

function waitForEvent(socket,event,{timeout=4000,predicate=()=>true}={}){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      socket.off(event,onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    },timeout);
    const onEvent=data=>{
      if(!predicate(data))return;
      clearTimeout(timer);
      socket.off(event,onEvent);
      resolve(data);
    };
    socket.on(event,onEvent);
  });
}

function withAck(socket,event,payload){
  return new Promise((resolve,reject)=>{
    socket.timeout(3000).emit(event,payload,(error,result)=>{
      if(error)reject(error);
      else resolve(result);
    });
  });
}

function startServer(){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['server.js'],{
      cwd:root,
      env:{
        ...process.env,
        PORT:'0',
        MONGODB_URI:'',
        ADMIN_KEY:'social-runtime-test',
        STRIPE_SECRET_KEY:'',
        STRIPE_WEBHOOK_SECRET:'',
        RESEND_API_KEY:'',
      },
      stdio:['ignore','pipe','pipe'],
    });
    let logs='';
    const timeout=setTimeout(()=>{
      child.kill();
      reject(new Error(`server did not start\n${logs}`));
    },5000);
    const collect=chunk=>{
      logs+=chunk.toString();
      const match=logs.match(/Arena\.io — port (\d+)/);
      if(!match)return;
      clearTimeout(timeout);
      resolve({child,url:`http://127.0.0.1:${match[1]}`});
    };
    child.stdout.on('data',collect);
    child.stderr.on('data',collect);
  });
}

async function connect(url){
  const socket=io(url,{
    transports:['websocket'],
    forceNew:true,
    reconnection:false,
    timeout:3000,
  });
  await waitForEvent(socket,'connect');
  return socket;
}

test('guest party leader launches every member into the same authoritative room',{timeout:12000},async t=>{
  const {child,url}=await startServer();
  const leader=await connect(url);
  const member=await connect(url);
  t.after(()=>{
    leader.disconnect();
    member.disconnect();
    child.kill();
  });

  const leaderParty=waitForEvent(leader,'partyState',{predicate:data=>data?.members?.length===1});
  const created=await withAck(leader,'partyCreate',{
    name:'nova7',platform:'web',
  });
  assert.equal(created.ok,true);
  await leaderParty;

  const joinedForLeader=waitForEvent(leader,'partyState',{predicate:data=>data?.members?.length===2});
  const joinedForMember=waitForEvent(member,'partyState',{predicate:data=>data?.members?.length===2});
  const joined=await withAck(member,'partyJoin',{
    code:created.code,name:'vex3',platform:'crazygames',
  });
  assert.equal(joined.ok,true);
  await Promise.all([joinedForLeader,joinedForMember]);

  const leaderLaunch=waitForEvent(leader,'partyLaunch');
  const memberLaunch=waitForEvent(member,'partyLaunch');
  assert.equal((await withAck(leader,'partyLaunch',{mode:'lms'})).ok,true);
  const launches=await Promise.all([leaderLaunch,memberLaunch]);
  assert.deepEqual(launches.map(item=>item.mode),['lms','lms']);

  const leaderInit=waitForEvent(leader,'init');
  const memberInit=waitForEvent(member,'init');
  leader.emit('join',{name:'nova7',mode:'lms',weapon:'pistol',platform:'web',viewport:{w:1280,h:720}});
  member.emit('join',{name:'vex3',mode:'lms',weapon:'smg',platform:'crazygames',viewport:{w:1280,h:720}});
  const [first,second]=await Promise.all([leaderInit,memberInit]);
  assert.equal(first.roomId,second.roomId);
  assert.equal(first.mode,'lms');
  assert.equal(second.mode,'lms');
});
