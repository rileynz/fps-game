'use strict';

function clampNumber(value, min, max, fallback = 0) {
  const number=Number(value);
  return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;
}

function percentile(values, percent) {
  if (!values.length) return 0;
  const sorted=values.slice().sort((a,b)=>a-b);
  const index=Math.min(sorted.length-1,Math.max(0,Math.ceil(percent*sorted.length)-1));
  return sorted[index];
}

function average(values) {
  return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
}

function createAdminMetrics(options={}) {
  const startedAt=Date.now();
  const monthlyLimitBytes=clampNumber(options.monthlyBandwidthGb,0.1,10000,5)*1e9;
  const durationLimit=1200;
  const sampleLimit=1500;
  const physicsDurations=[];
  const broadcastDurations=[];
  const performanceSamples=[];
  const realtimeByMode={ffa:0,ranked:0,tdm:0,lms:0,other:0};
  const realtimeByEvent={};
  let realtimeBytes=0;
  let httpBytes=0;
  let realtimePackets=0;
  let httpResponses=0;
  let playerSeconds=0;
  let peakOnline=0;
  let eventLoopLagMs=0;
  let expectedLoopAt=Date.now()+1000;

  const eventLoopTimer=setInterval(()=>{
    const now=Date.now();
    eventLoopLagMs=Math.max(0,now-expectedLoopAt);
    expectedLoopAt=now+1000;
  },1000);
  if (typeof eventLoopTimer.unref==='function') eventLoopTimer.unref();

  function pushBounded(target,value,limit) {
    target.push(value);
    if(target.length>limit)target.splice(0,target.length-limit);
  }

  function estimateEventBytes(event,payload) {
    if(Buffer.isBuffer(payload)){
      // Socket.IO sends one tiny placeholder event frame followed by the
      // binary attachment. Include both rather than JSON-stringifying Buffer,
      // which would wildly overstate protocol-v3 traffic.
      return payload.byteLength+Buffer.byteLength(String(event||''))+52;
    }
    if(ArrayBuffer.isView(payload)){
      return payload.byteLength+Buffer.byteLength(String(event||''))+52;
    }
    try{
      // Includes the Socket.IO event name and a small WebSocket framing
      // allowance. This is deliberately labelled as an estimate in the UI.
      return Buffer.byteLength(JSON.stringify([event,payload]))+8;
    }catch(error){
      return 0;
    }
  }

  return {
    httpMiddleware(req,res,next){
      let writtenBytes=0;
      const originalWrite=res.write;
      const originalEnd=res.end;
      const chunkBytes=chunk=>{
        if(Buffer.isBuffer(chunk))return chunk.length;
        if(ArrayBuffer.isView(chunk))return chunk.byteLength;
        if(typeof chunk==='string')return Buffer.byteLength(chunk);
        return 0;
      };
      res.write=function(chunk,...args){
        writtenBytes+=chunkBytes(chunk);
        return originalWrite.call(this,chunk,...args);
      };
      res.end=function(chunk,...args){
        writtenBytes+=chunkBytes(chunk);
        return originalEnd.call(this,chunk,...args);
      };
      res.on('finish',()=>{
        const length=Number(res.getHeader('content-length'));
        // When compression streams a response there may be no Content-Length.
        // With this middleware registered before compression, writtenBytes
        // counts the actual compressed response chunks.
        httpBytes+=writtenBytes||(Number.isFinite(length)&&length>0?length:0);
        httpResponses++;
      });
      next();
    },
    recordRealtime(mode,event,payload){
      const bytes=estimateEventBytes(event,payload);
      realtimeBytes+=bytes;
      realtimePackets++;
      const key=Object.prototype.hasOwnProperty.call(realtimeByMode,mode)?mode:'other';
      realtimeByMode[key]+=bytes;
      realtimeByEvent[event]=(realtimeByEvent[event]||0)+bytes;
      return bytes;
    },
    recordPhysicsTick(durationMs){
      pushBounded(physicsDurations,clampNumber(durationMs,0,10000),durationLimit);
    },
    recordBroadcastTick(durationMs){
      pushBounded(broadcastDurations,clampNumber(durationMs,0,10000),durationLimit);
    },
    recordPlayerTime(realPlayers,seconds){
      const count=Math.max(0,Math.floor(Number(realPlayers)||0));
      playerSeconds+=count*clampNumber(seconds,0,60);
      peakOnline=Math.max(peakOnline,count);
    },
    observeOnline(realPlayers){
      peakOnline=Math.max(peakOnline,Math.max(0,Math.floor(Number(realPlayers)||0)));
    },
    addPerformanceSample(sample={}){
      const platform=typeof sample.platform==='string'&&/^[a-z_]{2,24}$/.test(sample.platform)
        ?sample.platform:'unknown';
      pushBounded(performanceSamples,{
        ts:Date.now(),
        ping:clampNumber(sample.ping,0,5000),
        fps:clampNumber(sample.fps,0,240),
        platform,
      },sampleLimit);
    },
    summary({onlineNow=0}={}){
      this.observeOnline(onlineNow);
      const now=Date.now();
      const uptimeMs=Math.max(1,now-startedAt);
      const totalEstimatedBytes=realtimeBytes+httpBytes;
      const projectedMonthlyBytes=totalEstimatedBytes/uptimeMs*(30*24*60*60*1000);
      const recentCutoff=now-10*60*1000;
      const recent=performanceSamples.filter(sample=>sample.ts>=recentCutoff);
      const platformMap=new Map();
      for(const sample of recent){
        if(!platformMap.has(sample.platform))platformMap.set(sample.platform,{pings:[],fps:[]});
        const bucket=platformMap.get(sample.platform);
        bucket.pings.push(sample.ping);
        bucket.fps.push(sample.fps);
      }
      return {
        startedAt,
        uptimeMs,
        peakOnlineSinceDeploy:peakOnline,
        eventLoopLagMs,
        physics:{
          averageMs:average(physicsDurations),
          p95Ms:percentile(physicsDurations,.95),
          samples:physicsDurations.length,
        },
        broadcast:{
          averageMs:average(broadcastDurations),
          p95Ms:percentile(broadcastDurations,.95),
          samples:broadcastDurations.length,
        },
        clientPerformance:{
          sampleCount:recent.length,
          averagePingMs:average(recent.map(sample=>sample.ping)),
          p95PingMs:percentile(recent.map(sample=>sample.ping),.95),
          averageFps:average(recent.map(sample=>sample.fps)),
          lowFpsPercent:recent.length
            ?recent.filter(sample=>sample.fps>0&&sample.fps<42).length/recent.length*100
            :0,
          platforms:[...platformMap.entries()].map(([platform,bucket])=>({
            platform,
            samples:bucket.pings.length,
            averagePingMs:average(bucket.pings),
            p95PingMs:percentile(bucket.pings,.95),
            averageFps:average(bucket.fps),
          })),
        },
        network:{
          realtimeBytes,
          httpBytes,
          totalEstimatedBytes,
          realtimePackets,
          httpResponses,
          realtimeByMode:{...realtimeByMode},
          realtimeByEvent:{...realtimeByEvent},
          playerHours:playerSeconds/3600,
          estimatedMbPerPlayerHour:playerSeconds>0
            ?realtimeBytes/(playerSeconds/3600)/1e6
            :0,
          monthlyLimitBytes,
          projectedMonthlyBytes,
          projectedLimitPercent:monthlyLimitBytes
            ?projectedMonthlyBytes/monthlyLimitBytes*100
            :0,
        },
      };
    },
  };
}

module.exports={createAdminMetrics,percentile};
