'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.resolve(__dirname,'..');
const admin=fs.readFileSync(path.join(root,'public','admin.html'),'utf8');

test('admin analytics loads its chart library from the game server',()=>{
  assert.match(admin,/<script src="\/chart\.umd\.js"><\/script>/);
  assert.doesNotMatch(admin,/cdnjs\.cloudflare\.com/);
  assert.ok(fs.statSync(path.join(root,'public','chart.umd.js')).size>100000);
});

test('admin analytics survives missing charts and empty date ranges',()=>{
  assert.match(admin,/typeof window\.Chart!=='function'/);
  assert.match(admin,/No activity recorded in this date range\./);
  assert.match(admin,/Analytics could not be loaded:/);
});

test('shop table renders before charts and supports premium products',()=>{
  const tableRender=admin.indexOf("renderTable('cosmeticsTable'");
  const firstChart=admin.indexOf("mkChart('dauChart'");
  assert.ok(tableRender>0&&tableRender<firstChart);
  assert.match(admin,/data\.topShopItems/);
  assert.match(admin,/Premium purchases/);
  assert.match(admin,/Top Purchased Shop Items/);
});

test('every admin dashboard tab is wired to a populated view',()=>{
  for(const view of ['overview','players','gameplay','revenue','performance','announcements']){
    assert.match(admin,new RegExp(`data-view="${view}"`));
    assert.match(admin,new RegExp(`id="${view}View"`));
  }
  for(const cards of [
    'overviewCards','playersCards','gameplayCards','revenueCards','performanceCards',
  ]){
    assert.match(admin,new RegExp(`renderCards\\('${cards}'`));
  }
  assert.doesNotMatch(admin,/getElementById\('analyticsView'\)/);
  assert.doesNotMatch(admin,/getElementById\('cards'\)/);
});

test('itch.io has permanent analytics slots even before its first sample',()=>{
  assert.match(admin,/ANALYTICS_PLATFORM_ORDER=\['web','pwa','microsoft_store','crazygames','itch'\]/);
  assert.match(admin,/label:'itch\.io Joins'/);
  assert.match(admin,/tracked separately from website and PWA players/);
});

test('analytics summary includes gameplay and both shop purchase types',async()=>{
  const analytics=require('../analytics');
  analytics.init(null);
  analytics.logEvent('join',{name:'tester',mode:'ranked'});
  analytics.logEvent('session_end',{name:'tester',durationMs:90000});
  analytics.logEvent('match_start',{mode:'ranked'});
  analytics.logEvent('match_end',{mode:'ranked',mapId:'grid',durationMs:60000,playerCount:8});
  analytics.logEvent('purchase',{name:'tester',category:'trail',id:'neon',cost:250});
  analytics.logEvent('premium_purchase',{name:'tester',productKey:'shards_small',amount:299,currency:'nzd'});

  const summary=await analytics.getSummary({days:1});
  assert.equal(summary.daily[0].dau,1);
  assert.equal(summary.daily[0].sessions,1);
  assert.equal(summary.daily[0].matches.ranked,1);
  assert.equal(summary.daily[0].cosmeticPurchases,1);
  assert.equal(summary.daily[0].premiumPurchases,1);
  assert.equal(summary.daily[0].purchases,2);
  assert.equal(summary.daily[0].shardsSpent,250);
  assert.deepEqual(summary.mapPopularity,[{mapId:'grid',count:1}]);
  assert.deepEqual(summary.topShopItems,[
    {category:'trail',id:'neon',count:1},
    {category:'premium',id:'shards_small',count:1},
  ]);
});
