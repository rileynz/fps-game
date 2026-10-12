'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function overlapsObstacle(x, y, radius, obstacles) {
  for (const obstacle of obstacles) {
    const nearestX = Math.max(obstacle.x, Math.min(obstacle.x + obstacle.w, x));
    const nearestY = Math.max(obstacle.y, Math.min(obstacle.y + obstacle.h, y));
    const dx = x - nearestX;
    const dy = y - nearestY;
    if (dx * dx + dy * dy < radius * radius) return true;
  }
  return false;
}

function insideCircle(x, y, circle, margin = 0) {
  const usableRadius = Math.max(0, circle.radius - margin);
  const dx = x - circle.cx;
  const dy = y - circle.cy;
  return dx * dx + dy * dy <= usableRadius * usableRadius;
}

function clearOfPoints(x, y, points, minDistance) {
  const minDistanceSq = minDistance * minDistance;
  return points.every(point => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return true;
    const dx = x - point.x;
    const dy = y - point.y;
    return dx * dx + dy * dy >= minDistanceSq;
  });
}

function centreClearanceScore(cx, cy, radius, obstacles, playerRadius, random) {
  let score = overlapsObstacle(cx, cy, playerRadius * 2, obstacles) ? -20 : 8;
  const sampleRadius = Math.min(radius * 0.65, 180);
  for (let index = 0; index < 16; index++) {
    const angle = (index / 16) * Math.PI * 2;
    const ring = index % 2 === 0 ? sampleRadius : sampleRadius * 0.5;
    const x = cx + Math.cos(angle) * ring;
    const y = cy + Math.sin(angle) * ring;
    if (!overlapsObstacle(x, y, playerRadius * 1.5, obstacles)) score += 1;
  }
  return score + random() * 0.5;
}

function chooseNextCentre(previous, nextRadius, options) {
  const {
    worldW,
    worldH,
    obstacles,
    playerRadius,
    random,
  } = options;
  const containmentMargin = playerRadius * 1.5;
  const maxShift = Math.max(0, previous.radius - nextRadius - containmentMargin);
  const minX = nextRadius + containmentMargin;
  const maxX = worldW - nextRadius - containmentMargin;
  const minY = nextRadius + containmentMargin;
  const maxY = worldH - nextRadius - containmentMargin;
  let best = null;

  for (let attempt = 0; attempt < 28; attempt++) {
    const angle = random() * Math.PI * 2;
    // Every closing phase noticeably relocates the safe area. Keeping at least
    // 35% of the available shift avoids circles that technically moved but
    // still look centred to players.
    const distance = maxShift * (0.35 + Math.sqrt(random()) * 0.65);
    const cx = clamp(previous.cx + Math.cos(angle) * distance, minX, maxX);
    const cy = clamp(previous.cy + Math.sin(angle) * distance, minY, maxY);
    if (Math.hypot(cx - previous.cx, cy - previous.cy) > maxShift + 0.001) continue;
    const score = centreClearanceScore(
      cx, cy, nextRadius, obstacles, playerRadius, random
    );
    if (!best || score > best.score) best = { cx, cy, score };
  }
  return best ? { cx:best.cx, cy:best.cy } : { cx:previous.cx, cy:previous.cy };
}

function createStorm(options) {
  const {
    now,
    worldW,
    worldH,
    startRadius,
    minRadius,
    timeline,
    obstacles = [],
    playerRadius = 15,
    random = Math.random,
  } = options;
  const startCx = worldW / 2;
  const startCy = worldH / 2;
  const segments = [];
  let time = now;
  let previous = { cx:startCx, cy:startCy, radius:startRadius };

  for (const step of timeline) {
    const targetRadius = step.toFrac === null ? minRadius : startRadius * step.toFrac;
    const targetCentre = step.type === 'shrink'
      ? chooseNextCentre(previous, targetRadius, {
        worldW, worldH, obstacles, playerRadius, random,
      })
      : { cx:previous.cx, cy:previous.cy };
    const target = { ...targetCentre, radius:targetRadius };
    segments.push({
      type:step.type,
      startAt:time,
      endAt:time + step.durationMs,
      fromCx:previous.cx,
      fromCy:previous.cy,
      fromR:previous.radius,
      toCx:target.cx,
      toCy:target.cy,
      toR:target.radius,
    });
    time += step.durationMs;
    previous = target;
  }

  return {
    cx:startCx,
    cy:startCy,
    radius:startRadius,
    startRadius,
    minRadius,
    segments,
    finalCx:previous.cx,
    finalCy:previous.cy,
    finalR:previous.radius,
    timelineEndsAt:time,
  };
}

function updateStorm(storm, now) {
  if (!storm) return;
  if (now >= storm.timelineEndsAt) {
    storm.cx = storm.finalCx;
    storm.cy = storm.finalCy;
    storm.radius = storm.finalR;
    return;
  }
  for (const segment of storm.segments) {
    if (now < segment.startAt || now >= segment.endAt) continue;
    if (segment.type === 'hold') {
      storm.cx = segment.toCx;
      storm.cy = segment.toCy;
      storm.radius = segment.toR;
    } else {
      const progress = (now - segment.startAt) / (segment.endAt - segment.startAt);
      storm.cx = segment.fromCx + (segment.toCx - segment.fromCx) * progress;
      storm.cy = segment.fromCy + (segment.toCy - segment.fromCy) * progress;
      storm.radius = segment.fromR + (segment.toR - segment.fromR) * progress;
    }
    return;
  }
}

function getStormInfo(storm, now) {
  if (!storm) return null;
  const complete = now >= storm.timelineEndsAt;
  let current = storm.segments[storm.segments.length - 1];
  for (const segment of storm.segments) {
    if (now >= segment.startAt && now < segment.endAt) {
      current = segment;
      break;
    }
  }
  let preview = current.type === 'shrink' ? current : null;
  if (!preview) {
    const index = storm.segments.indexOf(current);
    for (let next = index + 1; next < storm.segments.length; next++) {
      if (storm.segments[next].type === 'shrink') {
        preview = storm.segments[next];
        break;
      }
    }
  }
  return {
    cx:Math.round(storm.cx),
    cy:Math.round(storm.cy),
    r:Math.round(storm.radius),
    nextCx:Math.round(preview ? preview.toCx : storm.finalCx),
    nextCy:Math.round(preview ? preview.toCy : storm.finalCy),
    nextR:Math.round(preview ? preview.toR : storm.finalR),
    phaseEndsAt:complete ? null : current.endAt,
    shrinking:!complete && current.type === 'shrink',
    complete,
  };
}

function findSafeSpawn(options) {
  const {
    spawns = [],
    zone,
    obstacles = [],
    worldW,
    worldH,
    playerRadius = 15,
    random = Math.random,
    avoidPoints = [],
  } = options;
  if (!zone) return null;
  const stormMargin = Math.min(
    Math.max(playerRadius * 4, 60),
    Math.max(playerRadius * 2, zone.radius * 0.28)
  );
  const safeRadius = Math.max(playerRadius * 2, zone.radius - stormMargin);
  const safeZone = { cx:zone.cx, cy:zone.cy, radius:safeRadius };
  const fixed = spawns
    .filter(spawn =>
      insideCircle(spawn.x, spawn.y, safeZone) &&
      !overlapsObstacle(spawn.x, spawn.y, playerRadius + 20, obstacles) &&
      clearOfPoints(spawn.x, spawn.y, avoidPoints, playerRadius * 4)
    )
    .sort(() => random() - 0.5);
  if (fixed.length) return { x:fixed[0].x, y:fixed[0].y };

  for (let attempt = 0; attempt < 100; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * safeRadius;
    const x = zone.cx + Math.cos(angle) * distance;
    const y = zone.cy + Math.sin(angle) * distance;
    if (x < playerRadius || y < playerRadius ||
        x > worldW - playerRadius || y > worldH - playerRadius) continue;
    if (!overlapsObstacle(x, y, playerRadius + 20, obstacles) &&
        clearOfPoints(x, y, avoidPoints, playerRadius * 4)) return { x, y };
  }

  for (const fraction of [0, 0.2, 0.4, 0.6, 0.8]) {
    for (let index = 0; index < 32; index++) {
      const angle = (index / 32) * Math.PI * 2;
      const x = zone.cx + Math.cos(angle) * safeRadius * fraction;
      const y = zone.cy + Math.sin(angle) * safeRadius * fraction;
      if (!overlapsObstacle(x, y, playerRadius + 8, obstacles) &&
          clearOfPoints(x, y, avoidPoints, playerRadius * 3)) return { x, y };
    }
  }

  // Extremely crowded rooms can exhaust the separation requirement. Prefer an
  // obstacle-free safe point over placing someone inside a wall.
  for (let index = 0; index < 64; index++) {
    const angle = (index / 64) * Math.PI * 2;
    const distance = safeRadius * ((index % 8) / 8);
    const x = zone.cx + Math.cos(angle) * distance;
    const y = zone.cy + Math.sin(angle) * distance;
    if (!overlapsObstacle(x, y, playerRadius, obstacles)) return { x, y };
  }

  return { x:zone.cx, y:zone.cy };
}

module.exports = {
  createStorm,
  updateStorm,
  getStormInfo,
  findSafeSpawn,
  insideCircle,
  overlapsObstacle,
};
