'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const {io} = require('socket.io-client');

const root=path.join(__dirname,'..');

function waitForEvent(emitter,event,{timeout=4000,predicate=()=>true}={}) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      emitter.off(event,onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    },timeout);
    const onEvent=(...args)=>{
      if(!predicate(...args))return;
      clearTimeout(timer);
      emitter.off(event,onEvent);
      resolve(args.length>1?args:args[0]);
    };
    emitter.on(event,onEvent);
  });
}

function startTestServer() {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['server.js'],{
      cwd:root,
      env:{
        ...process.env,
        PORT:'0',
        MONGODB_URI:'',
        ADMIN_KEY:'network-runtime-test',
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
    child.once('exit',code=>{
      clearTimeout(timeout);
      reject(new Error(`server exited early with ${code}\n${logs}`));
    });
  });
}

async function connectClient(url,transport,name) {
  const socket=io(url,{
    transports:[transport],
    upgrade:false,
    forceNew:true,
    reconnection:false,
    timeout:3000,
  });
  await waitForEvent(socket,'connect');
  const capability=await new Promise((resolve,reject)=>{
    socket.timeout(2000).emit('clientCapabilities',{compactState:4},(error,response)=>{
      if(error)reject(error);
      else resolve(response);
    });
  });
  assert.equal(capability.compactState,4);
  const initPromise=waitForEvent(socket,'init');
  socket.emit('join',{
    name,
    mode:'ffa',
    weapon:'smg',
    platform:'web',
    viewport:{w:1280,h:720},
  });
  const init=await initPromise;
  assert.equal(init.playerId,socket.id);
  assert.ok(init.roster[socket.id]);
  return {socket,init};
}

function packetBuffer(packet) {
  if(Buffer.isBuffer(packet))return packet;
  if(packet instanceof ArrayBuffer)return Buffer.from(packet);
  if(ArrayBuffer.isView(packet)){
    return Buffer.from(packet.buffer,packet.byteOffset,packet.byteLength);
  }
  return null;
}

function selfInputAck(packet,selfNetId) {
  const buffer=packetBuffer(packet);
  if(!buffer||buffer.length<12||buffer.readUInt8(0)!==4)return -1;
  const playerCount=buffer.readUInt16LE(5);
  let offset=12;
  for(let index=0;index<playerCount;index++){
    if(offset+10>buffer.length)return -1;
    const rowStart=offset;
    const netId=buffer.readUInt16LE(offset);
    const flags=buffer.readUInt8(offset+9);
    offset+=10;
    if(flags&4){
      if(offset+8>buffer.length)return -1;
      const ack=buffer.readUInt32LE(offset+4);
      offset+=8;
      if(netId===selfNetId)return ack;
    }else if(netId===selfNetId){
      return -1;
    }
    if(rowStart>=buffer.length)return -1;
  }
  return -1;
}

test('real server keeps v4 movement current over WebSocket and polling', {timeout:15000}, async t=>{
  const {child,url}=await startTestServer();
  const sockets=[];
  t.after(()=>{
    for(const socket of sockets)socket.disconnect();
    child.kill();
  });

  for(const [transport,name] of [['websocket','runtime_ws'],['polling','runtime_poll']]){
    const {socket,init}=await connectClient(url,transport,name);
    sockets.push(socket);
    assert.equal(socket.io.engine.transport.name,transport);

    let stateCount=0;
    let legacyBulletEvents=0;
    let sawBulletDelta=false;
    socket.on('state4',packet=>{
      stateCount++;
      const buffer=packetBuffer(packet);
      if(buffer&&buffer.length>=12&&buffer.readUInt16LE(8)>0)sawBulletDelta=true;
    });
    socket.on('bulletSpawn3',()=>legacyBulletEvents++);
    socket.on('bulletGone3',()=>legacyBulletEvents++);

    const selfNetId=init.roster[init.playerId].netId;
    const acknowledged=waitForEvent(socket,'state4',{
      predicate:packet=>selfInputAck(packet,selfNetId)>=1,
    });
    socket.emit('input',{
      keys:{up:false,down:false,left:false,right:true},
      angle:0,
      seq:1,
    });
    await acknowledged;

    const shotSeen=waitForEvent(socket,'state4',{
      predicate:packet=>{
        const buffer=packetBuffer(packet);
        return !!buffer&&buffer.length>=12&&buffer.readUInt16LE(8)>0;
      },
    });
    socket.emit('shoot',{angle:0});
    await shotSeen;

    const pingStarted=Date.now();
    const pong=waitForEvent(socket,'pong_check',{predicate:ts=>ts===pingStarted});
    socket.emit('ping_check',{ts:pingStarted});
    await pong;
    assert.ok(Date.now()-pingStarted<1000,`${transport} ping should not be queue-blocked`);

    await new Promise(resolve=>setTimeout(resolve,300));
    assert.ok(stateCount>=4,`${transport} should keep receiving state4`);
    assert.equal(legacyBulletEvents,0);
    assert.equal(sawBulletDelta,true);
  }
});
