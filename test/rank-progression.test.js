'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');

test('ranked matches with kills always move SR forward',()=>{
  assert.match(
    server,
    /if \(kills > 0\) delta = Math\.max\(delta, Math\.min\(20, kills \* 3\)\)/,
  );
});

test('earned rank tiers have permanent demotion protection',()=>{
  assert.match(server,/const newSR = Math\.max\(tier\.min, oldSR \+ delta\)/);
  assert.match(server,/return \{ delta:newSR-oldSR, newSR \}/);
});
