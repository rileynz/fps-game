'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createStorm,
  updateStorm,
  getStormInfo,
  findSafeSpawn,
  insideCircle,
  overlapsObstacle,
} = require('../storm');

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const timeline = [
  { durationMs:1000, type:'hold', toFrac:1 },
  { durationMs:2000, type:'shrink', toFrac:0.62 },
  { durationMs:1000, type:'hold', toFrac:0.62 },
  { durationMs:2000, type:'shrink', toFrac:0.36 },
  { durationMs:1000, type:'hold', toFrac:0.36 },
  { durationMs:2000, type:'shrink', toFrac:null },
];

test('closing circles shift position while remaining inside the prior circle and map', () => {
  const storm = createStorm({
    now:10000,
    worldW:2400,
    worldH:2400,
    startRadius:1160,
    minRadius:200,
    timeline,
    playerRadius:15,
    random:seededRandom(42),
  });
  const shrinks = storm.segments.filter(segment => segment.type === 'shrink');
  assert.equal(shrinks.length, 3);
  for (const segment of shrinks) {
    const shift = Math.hypot(segment.toCx - segment.fromCx, segment.toCy - segment.fromCy);
    assert.ok(shift > 20, `expected a visible centre shift, got ${shift}`);
    assert.ok(shift + segment.toR <= segment.fromR - 15 * 1.5 + 0.01);
    assert.ok(segment.toCx - segment.toR >= 0);
    assert.ok(segment.toCy - segment.toR >= 0);
    assert.ok(segment.toCx + segment.toR <= 2400);
    assert.ok(segment.toCy + segment.toR <= 2400);
  }
});

test('storm position and radius interpolate together and expose the next centre', () => {
  const storm = createStorm({
    now:0,
    worldW:2400,
    worldH:2400,
    startRadius:1160,
    minRadius:200,
    timeline,
    playerRadius:15,
    random:seededRandom(9),
  });
  const firstShrink = storm.segments.find(segment => segment.type === 'shrink');
  const halfway = (firstShrink.startAt + firstShrink.endAt) / 2;
  updateStorm(storm, halfway);
  assert.ok(Math.abs(storm.cx - (firstShrink.fromCx + firstShrink.toCx) / 2) < 0.001);
  assert.ok(Math.abs(storm.cy - (firstShrink.fromCy + firstShrink.toCy) / 2) < 0.001);
  assert.ok(Math.abs(storm.radius - (firstShrink.fromR + firstShrink.toR) / 2) < 0.001);
  const info = getStormInfo(storm, halfway);
  assert.equal(info.nextCx, Math.round(firstShrink.toCx));
  assert.equal(info.nextCy, Math.round(firstShrink.toCy));
  assert.equal(info.nextR, Math.round(firstShrink.toR));
});

test('Last Stand spawn selection stays in the storm and out of obstacles', () => {
  const zone = { cx:620, cy:760, radius:310 };
  const obstacles = [
    { x:560, y:700, w:120, h:120 },
    { x:430, y:540, w:80, h:160 },
  ];
  for (let seed = 1; seed <= 100; seed++) {
    const spawn = findSafeSpawn({
      spawns:[],
      zone,
      obstacles,
      worldW:2400,
      worldH:2400,
      playerRadius:15,
      random:seededRandom(seed),
    });
    assert.ok(insideCircle(spawn.x, spawn.y, zone, 60));
    assert.equal(overlapsObstacle(spawn.x, spawn.y, 35, obstacles), false);
  }
});

test('spawn selection avoids existing players when another safe point is available', () => {
  const zone = { cx:1200, cy:1200, radius:400 };
  const occupied = [{ x:1200, y:1200 }];
  for (let seed = 1; seed <= 50; seed++) {
    const spawn = findSafeSpawn({
      spawns:[{x:1200,y:1200},{x:1375,y:1200}],
      zone,
      obstacles:[],
      avoidPoints:occupied,
      worldW:2400,
      worldH:2400,
      playerRadius:15,
      random:seededRandom(seed),
    });
    assert.ok(Math.hypot(spawn.x-occupied[0].x,spawn.y-occupied[0].y)>=60);
  }
});

test('finished storm reports a stable final circle instead of a zero-second phase', () => {
  const storm = createStorm({
    now:0,
    worldW:2400,
    worldH:2400,
    startRadius:1160,
    minRadius:200,
    timeline,
    playerRadius:15,
    random:seededRandom(7),
  });
  const afterEnd=storm.timelineEndsAt+5000;
  updateStorm(storm,afterEnd);
  const info=getStormInfo(storm,afterEnd);
  assert.equal(info.complete,true);
  assert.equal(info.shrinking,false);
  assert.equal(info.phaseEndsAt,null);
  assert.equal(info.r,Math.round(storm.minRadius));
});
