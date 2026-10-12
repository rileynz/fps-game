'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

test('sniper is a server-authoritative one-shot with a long reload',()=>{
  assert.match(server,/sniper:\s*\{[^}]*damage:100[^}]*fireCooldown:96/);
  assert.match(client,/sniper:\{fireCooldown:96\}/);
  assert.match(server,/const wpn=WEAPONS\[p\.weapon\]\|\|WEAPONS\[DEFAULT_WEAPON\]/);
  assert.match(server,/dmg:wpn\.damage/);
});

test('mobile aim-stick drag intentionally enables and releases automatic fire',()=>{
  assert.match(client,/let aimDragShoot=false/);
  assert.match(client,/aimDragShoot=strength>=0\.58/);
  assert.match(client,/isMobile\?\(mobileShoot\|\|aimDragShoot\):controlPressed\('fire'\)/);
  assert.match(client,/function aimEnd\(e\).*aimDragShoot=false.*classList\.remove\('firing'\)/s);
  assert.match(client,/function releaseAllInputs\(\).*aimDragShoot=false/s);
  assert.match(client,/getElementById\('joy-move-stick'\)/);
  assert.match(client,/getElementById\('joy-aim-stick'\)/);
});

test('trail cosmetics carry vivid palettes into public rendering and previews',()=>{
  assert.match(server,/id:'tr_void'[^\n]*style:'void'[^\n]*palette:\[[^\]]*'#c77dff'[^\]]*'#00e5ff'/);
  assert.match(server,/id:'tr_supporter_plasma'[^\n]*style:'plasma'[^\n]*palette:/);
  assert.match(server,/id:'tr_elite_nova'[^\n]*style:'nova'[^\n]*palette:/);
  assert.match(server,/palette:Array\.isArray\(tr\.palette\)\?tr\.palette\.slice\(0,6\):null/);
  assert.match(client,/function traceSmoothTrail\(pts\)/);
  assert.match(client,/style==='plasma'\|\|style==='nova'\|\|style==='comet'/);
  assert.match(client,/class="shop-swatch trail-swatch"/);
  const trailRenderer=client.slice(client.indexOf('function drawTrail'),client.indexOf('function drawPlayer'));
  assert.doesNotMatch(trailRenderer,/Math\.random\(\)/);
});

test('all maps use distinct cached Arena.io environment themes',()=>{
  for(const id of ['arena','desert','castle','maze','industrial']){
    assert.match(client,new RegExp(`${id}:\\{floor:`));
  }
  assert.match(client,/function drawMapFloor\(oc,theme\)/);
  assert.match(client,/drawMapFloor\(oc,theme\)/);
  assert.match(client,/Floor, grid, scenery and obstacles are baked together when the map loads/);
  const renderLoop=client.slice(client.indexOf('function loop('),client.indexOf('requestAnimationFrame(loop);'));
  assert.doesNotMatch(renderLoop,/drawMapFloor\(/);
});

test('streak UI is event-driven instead of expanding realtime snapshots',()=>{
  assert.match(server,/awardKillStreak\(room,shooter,now\)/);
  assert.match(server,/killStreaks\.movementMultiplier\(p,now\)/);
  assert.match(server,/killStreaks\.cooldownMultiplier\(p,Date\.now\(\)\)/);
  assert.match(client,/socket\.on\('streakReward'/);
  assert.match(client,/id="streak-chip"/);
  assert.match(client,/id="streak-toast"/);
});
