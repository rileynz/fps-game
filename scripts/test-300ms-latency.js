'use strict';

const net=require('node:net');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const {io}=require('socket.io-client');

const CONFIGURED_RTT_MS=Math.max(100,Math.min(1200,
  Number(process.env.SIMULATED_RTT_MS)||300
));
const ONE_WAY_DELAY_MS=CONFIGURED_RTT_MS/2;
const PLAYER_SPEED=4;
const FRAME_MS=1000/60;
const PLAYER_R=15;
const PROJECT_ROOT=path.join(__dirname,'..');

function waitEvent(emitter,name,timeout=6000) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{
      emitter.off(name,onValue);
      reject(new Error(`timeout waiting for ${name}`));
    },timeout);
    const onValue=value=>{
      clearTimeout(timer);
      emitter.off(name,onValue);
      resolve(value);
    };
    emitter.on(name,onValue);
  });
}

async function startServer() {
  const child=spawn(process.execPath,['server.js'],{
    cwd:PROJECT_ROOT,
    env:{...process.env,PORT:'0',MONGODB_URI:'',ADMIN_KEY:'delay-diagnostic'},
    stdio:['ignore','pipe','pipe'],
  });
  let logs='';
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(logs)),5000);
    const collect=chunk=>{
      logs+=chunk.toString();
      const match=logs.match(/Arena\.io — port (\d+)/);
      if(match){
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on('data',collect);
    child.stderr.on('data',collect);
  });
  return {child,port};
}

async function startDelayProxy(targetPort) {
  const sockets=new Set();
  const server=net.createServer(inbound=>{
    const outbound=net.connect(targetPort,'127.0.0.1');
    sockets.add(inbound);sockets.add(outbound);
    inbound.on('data',chunk=>setTimeout(()=>{
      if(!outbound.destroyed)outbound.write(chunk);
    },ONE_WAY_DELAY_MS));
    outbound.on('data',chunk=>setTimeout(()=>{
      if(!inbound.destroyed)inbound.write(chunk);
    },ONE_WAY_DELAY_MS));
    inbound.on('close',()=>outbound.destroy());
    outbound.on('close',()=>inbound.destroy());
    inbound.on('error',()=>outbound.destroy());
    outbound.on('error',()=>inbound.destroy());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {
    server,
    sockets,
    port:server.address().port,
    close(){
      for(const socket of sockets)socket.destroy();
      server.close();
    },
  };
}

function packetBuffer(packet) {
  if(Buffer.isBuffer(packet))return packet;
  if(packet instanceof ArrayBuffer)return Buffer.from(packet);
  if(ArrayBuffer.isView(packet)){
    return Buffer.from(packet.buffer,packet.byteOffset,packet.byteLength);
  }
  return null;
}

function decodeSelf(packet,selfNetId) {
  const buffer=packetBuffer(packet);
  if(!buffer||buffer.length<12||buffer.readUInt8(0)!==4)return null;
  const count=buffer.readUInt16LE(5);
  let offset=12;
  for(let index=0;index<count;index++){
    if(offset+10>buffer.length)return null;
    const netId=buffer.readUInt16LE(offset);
    const x=buffer.readUInt16LE(offset+2);
    const y=buffer.readUInt16LE(offset+4);
    const flags=buffer.readUInt8(offset+9);
    offset+=10;
    let ack=-1;
    if(flags&4){
      if(offset+8>buffer.length)return null;
      ack=buffer.readUInt32LE(offset+4);
      offset+=8;
    }
    if(netId===selfNetId)return{x,y,alive:!!(flags&1),ack};
  }
  return null;
}

function overlaps(x,y,worldW,worldH,obstacles) {
  if(x<PLAYER_R||x>worldW-PLAYER_R||y<PLAYER_R||y>worldH-PLAYER_R)return true;
  for(const obstacle of obstacles){
    const nx=Math.max(obstacle.x,Math.min(obstacle.x+obstacle.w,x));
    const ny=Math.max(obstacle.y,Math.min(obstacle.y+obstacle.h,y));
    const dx=x-nx,dy=y-ny;
    if(dx*dx+dy*dy<PLAYER_R*PLAYER_R)return true;
  }
  return false;
}

function movePoint(point,vector,distance,worldW,worldH,obstacles) {
  let{x,y}=point;
  const nx=Math.max(PLAYER_R,Math.min(worldW-PLAYER_R,x+vector.x*distance));
  const ny=Math.max(PLAYER_R,Math.min(worldH-PLAYER_R,y+vector.y*distance));
  if(!overlaps(nx,y,worldW,worldH,obstacles))x=nx;
  if(!overlaps(x,ny,worldW,worldH,obstacles))y=ny;
  return{x,y};
}

function chooseDirection(spawn,worldW,worldH,obstacles) {
  const options=[
    {name:'right',x:1,y:0,keys:{up:false,down:false,left:false,right:true}},
    {name:'left',x:-1,y:0,keys:{up:false,down:false,left:true,right:false}},
    {name:'down',x:0,y:1,keys:{up:false,down:true,left:false,right:false}},
    {name:'up',x:0,y:-1,keys:{up:true,down:false,left:false,right:false}},
  ];
  for(const option of options){
    let point={...spawn},steps=0;
    for(;steps<120;steps++){
      const moved=movePoint(point,option,PLAYER_SPEED,worldW,worldH,obstacles);
      if(moved.x===point.x&&moved.y===point.y)break;
      point=moved;
    }
    option.clearSteps=steps;
  }
  return options.sort((a,b)=>b.clearSteps-a.clearSteps)[0];
}

function percentile(values,fraction) {
  const sorted=values.slice().sort((a,b)=>a-b);
  return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]||0;
}

async function main() {
  const backend=await startServer();
  const proxy=await startDelayProxy(backend.port);
  const socket=io(`http://127.0.0.1:${proxy.port}`,{
    transports:['websocket'],
    upgrade:false,
    reconnection:false,
    forceNew:true,
  });
  try{
    await waitEvent(socket,'connect');
    const measuredPing=await new Promise(resolve=>{
      const started=performance.now();
      const stamp=Date.now();
      socket.on('pong_check',value=>{
        if(value===stamp)resolve(performance.now()-started);
      });
      socket.emit('ping_check',{ts:stamp});
    });
    await new Promise((resolve,reject)=>{
      socket.timeout(3000).emit('clientCapabilities',{compactState:4},(error,response)=>{
        if(error||response?.compactState!==4)reject(error||new Error('v4 rejected'));
        else resolve();
      });
    });
    const initPromise=waitEvent(socket,'init');
    socket.emit('join',{
      name:'delay_test',
      mode:'ffa',
      weapon:'pistol',
      platform:'web',
      viewport:{w:1280,h:720},
    });
    const init=await initPromise;
    const direction=chooseDirection(
      init.spawn,init.worldW,init.worldH,init.obstacles,
    );
    const simulations={
      fixed:{point:{...init.spawn},corrections:[],frameTravel:[]},
      brokenHalfRtt:{point:{...init.spawn},corrections:[],frameTravel:[]},
      legacy:{point:{...init.spawn},corrections:[],frameTravel:[]},
    };
    const selfNetId=init.roster[init.playerId].netId;
    let snapshot=null;
    let snapshotArrivedAt=0;
    let lastServerAck=0;
    let startedAt=0;
    let lastFrameAt=performance.now();
    socket.on('state4',packet=>{
      const decoded=decodeSelf(packet,selfNetId);
      if(!decoded)return;
      snapshot=decoded;
      snapshotArrivedAt=performance.now();
      lastServerAck=Math.max(lastServerAck,decoded.ack);
    });
    await new Promise(resolve=>{
      const wait=setInterval(()=>{
        if(snapshot){
          clearInterval(wait);
          resolve();
        }
      },10);
    });
    socket.emit('input',{keys:direction.keys,angle:0,seq:1});
    startedAt=performance.now();
    await new Promise(resolve=>{
      const frame=setInterval(()=>{
        const now=performance.now();
        const dt=Math.min(50,now-lastFrameAt);
        lastFrameAt=now;
        for(const simulation of Object.values(simulations)){
          const beforeFrame={...simulation.point};
          simulation.point=movePoint(
            simulation.point,direction,
            PLAYER_SPEED*(dt/16.67),
            init.worldW,init.worldH,init.obstacles,
          );
          const beforeCorrection={...simulation.point};
          if(snapshot){
            const waiting=lastServerAck<1;
            if(simulation===simulations.legacy||!waiting){
              let target={x:snapshot.x,y:snapshot.y};
              if(simulation!==simulations.legacy){
                const projectionMs=simulation===simulations.brokenHalfRtt
                  ?measuredPing*.5+25
                  :measuredPing+(now-snapshotArrivedAt);
                const steps=Math.max(1,Math.ceil(projectionMs/16.67));
                for(let step=0;step<steps;step++){
                  target=movePoint(
                    target,direction,
                    PLAYER_SPEED*(projectionMs/16.67)/steps,
                    init.worldW,init.worldH,init.obstacles,
                  );
                }
              }
              const dx=target.x-simulation.point.x;
              const dy=target.y-simulation.point.y;
              const distance=Math.hypot(dx,dy);
              const correction=1-Math.pow(1-.06,Math.max(1,dt)/16.67);
              if(distance>100)simulation.point=target;
              else{
                simulation.point.x+=dx*correction;
                simulation.point.y+=dy*correction;
              }
            }
          }
          const correctionDistance=Math.hypot(
            simulation.point.x-beforeCorrection.x,
            simulation.point.y-beforeCorrection.y,
          );
          const signedCorrection=
            (simulation.point.x-beforeCorrection.x)*direction.x+
            (simulation.point.y-beforeCorrection.y)*direction.y;
          const frameTravel=
            (simulation.point.x-beforeFrame.x)*direction.x+
            (simulation.point.y-beforeFrame.y)*direction.y;
          if(lastServerAck>=1&&now-startedAt>500){
            simulation.corrections.push({distance:correctionDistance,signed:signedCorrection});
            simulation.frameTravel.push(frameTravel);
          }
        }
        if(now-startedAt>=2200){
          clearInterval(frame);
          resolve();
        }
      },FRAME_MS);
    });
    socket.emit('input',{
      keys:{up:false,down:false,left:false,right:false},
      angle:0,
      seq:2,
    });
    const results={};
    for(const[name,simulation]of Object.entries(simulations)){
      const correctionDistances=simulation.corrections.map(item=>item.distance);
      const backwards=simulation.corrections
        .filter(item=>item.signed<0)
        .map(item=>-item.signed);
      const meanTravel=simulation.frameTravel.reduce((a,b)=>a+b,0)
        /Math.max(1,simulation.frameTravel.length);
      const travelVariance=simulation.frameTravel.reduce(
        (sum,value)=>sum+(value-meanTravel)**2,0,
      )/Math.max(1,simulation.frameTravel.length);
      results[name]={
        meanCorrectionPerFrame:Number((
          correctionDistances.reduce((a,b)=>a+b,0)
          /Math.max(1,correctionDistances.length)
        ).toFixed(3)),
        p95Correction:Number(percentile(correctionDistances,.95).toFixed(3)),
        totalBackwardCorrection:Number(backwards.reduce((a,b)=>a+b,0).toFixed(2)),
        frameTravelStdDev:Number(Math.sqrt(travelVariance).toFixed(3)),
      };
    }
    const report={
      status:'passed',
      configuredRttMs:ONE_WAY_DELAY_MS*2,
      measuredPingMs:Number(measuredPing.toFixed(1)),
      direction:direction.name,
      clearDistance:direction.clearSteps*PLAYER_SPEED,
      serverAck:lastServerAck,
      results,
    };
    const clientSource=fs.readFileSync(
      path.join(PROJECT_ROOT,'public','index.html'),
      'utf8',
    );
    if(
      !clientSource.includes('(networkRttMs||ping||0)+snapshotAgeMs')
      ||clientSource.includes('(ping||0)*0.5+snapshotIntervalMs*0.5')
    ){
      throw new Error('the browser client is not using full-RTT input replay');
    }
    const minimumExpected=CONFIGURED_RTT_MS*.82;
    const maximumExpected=CONFIGURED_RTT_MS+180;
    if(measuredPing<minimumExpected||measuredPing>maximumExpected){
      throw new Error(`expected approximately ${CONFIGURED_RTT_MS} ms RTT, measured ${measuredPing.toFixed(1)}`);
    }
    if(lastServerAck<1)throw new Error('server did not acknowledge movement input');
    if(results.fixed.meanCorrectionPerFrame>=0.2){
      throw new Error(`fixed correction remained too high: ${results.fixed.meanCorrectionPerFrame}`);
    }
    if(
      results.fixed.totalBackwardCorrection
      >=results.brokenHalfRtt.totalBackwardCorrection*.4
    ){
      throw new Error('full-RTT replay did not materially reduce backward correction');
    }
    if(
      results.fixed.frameTravelStdDev
      >=results.brokenHalfRtt.frameTravelStdDev*.5
    ){
      throw new Error('full-RTT replay did not materially smooth frame travel');
    }
    console.log(JSON.stringify(report,null,2));
  } finally {
    socket.disconnect();
    proxy.close();
    backend.child.kill();
  }
}

main().catch(error=>{
  console.error(error);
  process.exitCode=1;
});
