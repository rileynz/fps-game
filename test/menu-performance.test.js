'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const client=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

test('the hidden arena is not rendered behind the main menu',()=>{
  const loopStart=client.indexOf('function loop(ts){');
  const firstCanvasDraw=client.indexOf("ctx.fillStyle='#1a1a2e'",loopStart);
  const earlyReturn=client.indexOf('if(!inGame||uiScrollActive)',loopStart);
  assert.ok(loopStart>=0);
  assert.ok(earlyReturn>loopStart&&earlyReturn<firstCanvasDraw);
  assert.match(client,/if\(!inGame\|\|uiScrollActive\)\{\s*fLast=ts;\s*return;/);
});

test('scroll detection is passive and temporarily prioritizes menu input',()=>{
  assert.match(client,/document\.addEventListener\('scroll'/);
  assert.match(client,/\{passive:true,capture:true\}/);
  assert.match(client,/uiScrollActive=true/);
  assert.match(client,/uiScrollActive=false/);
  assert.match(client,/menu-scroll-active/);
});

test('scrollable menu cards use paint containment and compositor-friendly layers',()=>{
  assert.match(client,/#menu,\.menu-account-card,#settings-bind-list,#daily-body,#shop-body/);
  assert.match(client,/\.shop-item,\.dc-row,\.bind-row\{\s*contain:layout paint style;/);
  assert.match(client,/\.menu-announcement\{contain:layout style\}/);
  assert.match(client,/transform:translateZ\(0\)/);
  assert.match(client,/body\.menu-scroll-active \.shop-swatch\.trail-swatch\{[\s\S]*?animation-play-state:paused!important/);
});
