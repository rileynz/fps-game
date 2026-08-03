'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createAdminMetrics,percentile}=require('../admin-metrics');

test('admin runtime metrics estimate realtime traffic by mode',()=>{
  const metrics=createAdminMetrics({monthlyBandwidthGb:5});
  metrics.recordRealtime('ffa','state2',[1,2,[],[]]);
  metrics.recordRealtime('lms','roomMeta2',[1,0,123]);
  metrics.recordPlayerTime(2,10);
  metrics.recordPhysicsTick(2);
  metrics.recordPhysicsTick(5);
  metrics.recordBroadcastTick(3);
  const summary=metrics.summary({onlineNow:2});
  assert.ok(summary.network.realtimeBytes>0);
  assert.ok(summary.network.realtimeByMode.ffa>0);
  assert.ok(summary.network.realtimeByMode.lms>0);
  assert.equal(summary.network.monthlyLimitBytes,5e9);
  assert.ok(summary.network.estimatedMbPerPlayerHour>0);
  assert.equal(summary.peakOnlineSinceDeploy,2);
});

test('admin runtime metrics aggregate safe client performance samples',()=>{
  const metrics=createAdminMetrics();
  metrics.addPerformanceSample({platform:'crazygames',ping:40,fps:60});
  metrics.addPerformanceSample({platform:'crazygames',ping:80,fps:30});
  metrics.addPerformanceSample({platform:'not valid!',ping:Infinity,fps:9999});
  const result=metrics.summary().clientPerformance;
  assert.equal(result.sampleCount,3);
  assert.equal(Math.round(result.averagePingMs),40);
  assert.equal(result.p95PingMs,80);
  assert.equal(Math.round(result.lowFpsPercent),33);
  assert.equal(result.platforms.find(row=>row.platform==='crazygames').samples,2);
});

test('percentile handles empty and unsorted samples',()=>{
  assert.equal(percentile([],0.95),0);
  assert.equal(percentile([9,1,5],0.5),5);
  assert.equal(percentile([9,1,5],0.95),9);
});

test('broadcast timing starts inside the broadcast callback',()=>{
  const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');
  const broadcast=server.match(/\/\/ ── Broadcast[\s\S]*?\},BROADCAST_MS\);/)?.[0]||'';
  assert.match(broadcast,/const broadcastStarted=performance\.now\(\)/);
  assert.match(broadcast,/recordBroadcastTick\(performance\.now\(\)-broadcastStarted\)/);
});
