// ── Analytics ────────────────────────────────────────────────────────────────
// Lightweight event tracking. Every event is written to a Mongo collection
// (analytics_events) when a DB is connected, and also kept in a rolling
// in-memory buffer so the dashboard still works locally without Mongo.
//
// Event shape: { type, ts (ms epoch), day ('YYYY-MM-DD' UTC), ...fields }

let db = null;
const MEM_BUFFER_MAX = 20000;
const memBuffer = [];

function dayKeyFor(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function init(database) {
  db = database;
  if (db) {
    db.collection('analytics_events').createIndex({ day: 1, type: 1 }).catch(() => {});
    db.collection('analytics_events').createIndex({ ts: 1 }).catch(() => {});
  }
}

function logEvent(type, data = {}) {
  const ts = Date.now();
  const evt = { type, ts, day: dayKeyFor(ts), ...data };
  memBuffer.push(evt);
  if (memBuffer.length > MEM_BUFFER_MAX) memBuffer.shift();
  if (db) {
    db.collection('analytics_events').insertOne(evt).catch(e => {
      console.error('analytics logEvent err:', e.message);
    });
  }
}

async function deletePlayerData(name) {
  const target=String(name||'');
  if (!target) return;
  for (let index=memBuffer.length-1;index>=0;index--) {
    if (memBuffer[index]&&memBuffer[index].name===target) memBuffer.splice(index,1);
  }
  if (db) await db.collection('analytics_events').deleteMany({name:target});
}

// Returns the last `days` day-keys (oldest first), including today.
function lastDayKeys(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

// Builds the full dashboard payload. Uses Mongo aggregation when available,
// otherwise falls back to scanning the in-memory buffer (dev / no-DB mode).
async function getSummary({ days = 14 } = {}) {
  const dayKeys = lastDayKeys(days);
  const minDay = dayKeys[0];

  if (db) {
    const col = db.collection('analytics_events');
    const match = { day: { $gte: minDay } };

    const [
      dauRows, sessionRows, matchStartRows, matchEndRows, mapRows,
      purchaseRows, premiumPurchaseRows, topCosmeticRows, topPremiumRows,
      modeJoinRows, platformRows, eventTypeRows, sessionReasonRows,
      uniquePlayerRows, hourRows,
    ] = await Promise.all([
      // Distinct players per day (DAU)
      col.aggregate([
        { $match: { ...match, type: 'join' } },
        { $group: { _id: { day: '$day', name: '$name' } } },
        { $group: { _id: '$_id.day', count: { $sum: 1 } } },
      ]).toArray(),
      // Sessions + playtime per day
      col.aggregate([
        { $match: { ...match, type: 'session_end' } },
        { $group: { _id: '$day', sessions: { $sum: 1 }, totalMs: { $sum: '$durationMs' }, avgMs: { $avg: '$durationMs' } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'match_start' } },
        { $group: { _id: { day: '$day', mode: '$mode' }, count: { $sum: 1 } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'match_end' } },
        { $group: { _id: '$mode', count: { $sum: 1 }, avgDurationMs: { $avg: '$durationMs' }, avgPlayers: { $avg: '$playerCount' } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'match_end' } },
        { $group: { _id: '$mapId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'purchase' } },
        { $group: { _id: '$day', count: { $sum: 1 }, shardsSpent: { $sum: '$cost' } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'premium_purchase' } },
        { $group: { _id: '$day', count: { $sum: 1 } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'purchase' } },
        { $group: { _id: { category: '$category', id: '$id' }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'premium_purchase' } },
        { $group: { _id: '$productKey', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'join' } },
        { $group: { _id: '$mode', count: { $sum: 1 } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: 'join' } },
        { $group: { _id: { $ifNull:['$platform','web'] }, count: { $sum:1 } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type: { $in:[
          'shop_view','checkout_start','checkout_cancel','premium_purchase','purchase',
        ] } } },
        { $group: { _id:'$type', count: { $sum:1 } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type:'session_end' } },
        { $group: { _id: { $ifNull:['$reason','unknown'] }, count: { $sum:1 } } },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type:'join' } },
        { $group: { _id:'$name' } },
        { $count:'count' },
      ]).toArray(),
      col.aggregate([
        { $match: { ...match, type:'join' } },
        { $project: { hour: { $hour: { $toDate:'$ts' } } } },
        { $group: { _id:'$hour', count: { $sum:1 } } },
        { $sort: { _id:1 } },
      ]).toArray(),
    ]);

    // New vs returning: first-ever join day per player (looked up across ALL history, not just window)
    const allFirstJoin = await col.aggregate([
      { $match: { type: 'join' } },
      { $group: { _id: '$name', firstDay: { $min: '$day' } } },
    ]).toArray();
    const firstDayByName = new Map(allFirstJoin.map(r => [r._id, r.firstDay]));
    const joinsInWindow = await col.find({ ...match, type: 'join' }).project({ name: 1, day: 1 }).toArray();
    const newVsReturning = {};
    for (const dk of dayKeys) newVsReturning[dk] = { new: new Set(), returning: new Set() };
    for (const j of joinsInWindow) {
      const bucket = newVsReturning[j.day];
      if (!bucket) continue;
      if (firstDayByName.get(j.name) === j.day) bucket.new.add(j.name);
      else bucket.returning.add(j.name);
    }
    const retention=buildCohortRetention(dayKeys,newVsReturning,joinsInWindow);

    return assemble({
      dayKeys, dauRows, sessionRows, matchStartRows, matchEndRows, mapRows,
      purchaseRows, premiumPurchaseRows, topCosmeticRows, topPremiumRows,
      modeJoinRows, newVsReturning,platformRows,eventTypeRows,sessionReasonRows,
      uniquePlayerRows,hourRows,retention,
      source: 'mongo',
    });
  }

  // ── In-memory fallback (no Mongo connected) ──────────────────────────────
  const events = memBuffer.filter(e => e.day >= minDay);
  const dauRows = groupCount(events.filter(e => e.type === 'join'), e => e.day, e => e.name);
  const sessionEvents = events.filter(e => e.type === 'session_end');
  const sessionRows = daySessionStats(sessionEvents);
  const matchStartRows = groupCount(events.filter(e => e.type === 'match_start'), e => `${e.day}|${e.mode}`);
  const matchEndEvents = events.filter(e => e.type === 'match_end');
  const matchEndRows = modeMatchStats(matchEndEvents);
  const mapRows = groupCount(matchEndEvents, e => e.mapId).sort((a, b) => b.count - a.count);
  const purchaseEvents = events.filter(e => e.type === 'purchase');
  const premiumPurchaseEvents = events.filter(e => e.type === 'premium_purchase');
  const purchaseRows = dayPurchaseStats(purchaseEvents);
  const premiumPurchaseRows = dayPurchaseStats(premiumPurchaseEvents);
  const topCosmeticRows = groupCount(purchaseEvents, e => `${e.category}|${e.id}`).sort((a, b) => b.count - a.count).slice(0, 10);
  const topPremiumRows = groupCount(premiumPurchaseEvents, e => e.productKey).sort((a, b) => b.count - a.count).slice(0, 10);
  const modeJoinRows = groupCount(events.filter(e => e.type === 'join'), e => e.mode);
  const platformRows=groupCount(events.filter(e=>e.type==='join'),e=>e.platform||'web');
  const eventTypeRows=groupCount(events.filter(e=>[
    'shop_view','checkout_start','checkout_cancel','premium_purchase','purchase',
  ].includes(e.type)),e=>e.type);
  const sessionReasonRows=groupCount(sessionEvents,e=>e.reason||'unknown');
  const uniquePlayerRows=[{count:new Set(events.filter(e=>e.type==='join').map(e=>e.name)).size}];
  const hourRows=groupCount(events.filter(e=>e.type==='join'),e=>new Date(e.ts).getUTCHours());

  const allFirst = new Map();
  for (const e of memBuffer.filter(e => e.type === 'join').sort((a, b) => a.ts - b.ts)) {
    if (!allFirst.has(e.name)) allFirst.set(e.name, e.day);
  }
  const newVsReturning = {};
  for (const dk of dayKeys) newVsReturning[dk] = { new: new Set(), returning: new Set() };
  for (const e of events.filter(e => e.type === 'join')) {
    const bucket = newVsReturning[e.day];
    if (!bucket) continue;
    if (allFirst.get(e.name) === e.day) bucket.new.add(e.name);
    else bucket.returning.add(e.name);
  }
  const joinsInWindow=events.filter(e=>e.type==='join');
  const retention=buildCohortRetention(dayKeys,newVsReturning,joinsInWindow);

  return assemble({
    dayKeys, dauRows, sessionRows, matchStartRows, matchEndRows, mapRows,
    purchaseRows, premiumPurchaseRows, topCosmeticRows, topPremiumRows,
    modeJoinRows, newVsReturning,platformRows,eventTypeRows,sessionReasonRows,
    uniquePlayerRows,hourRows,retention,
    source: 'memory',
  });
}

function addUtcDays(day,amount) {
  const date=new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate()+amount);
  return dayKeyFor(date.getTime());
}

function buildCohortRetention(dayKeys,newVsReturning,joinEvents) {
  const joinedDaysByName=new Map();
  for(const event of joinEvents){
    if(!event||!event.name||!event.day)continue;
    if(!joinedDaysByName.has(event.name))joinedDaysByName.set(event.name,new Set());
    joinedDaysByName.get(event.name).add(event.day);
  }
  const lastDay=dayKeys[dayKeys.length-1]||'';
  const calculate=offset=>{
    let eligible=0;
    let returned=0;
    for(const day of dayKeys){
      const target=addUtcDays(day,offset);
      if(target>lastDay)continue;
      const cohort=newVsReturning[day]?.new||new Set();
      for(const name of cohort){
        eligible++;
        if(joinedDaysByName.get(name)?.has(target))returned++;
      }
    }
    return {
      eligible,
      returned,
      percent:eligible?returned/eligible*100:0,
    };
  };
  return {day1:calculate(1),day7:calculate(7)};
}

function groupCount(list, keyFn, uniqFn = null) {
  const map = new Map();
  const uniqSets = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (uniqFn) {
      if (!uniqSets.has(k)) uniqSets.set(k, new Set());
      uniqSets.get(k).add(uniqFn(item));
    } else {
      map.set(k, (map.get(k) || 0) + 1);
    }
  }
  if (uniqFn) {
    return [...uniqSets.entries()].map(([_id, set]) => ({ _id, count: set.size }));
  }
  return [...map.entries()].map(([_id, count]) => ({ _id, count }));
}

function daySessionStats(sessionEvents) {
  const byDay = new Map();
  for (const e of sessionEvents) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e.durationMs || 0);
  }
  return [...byDay.entries()].map(([_id, arr]) => ({
    _id, sessions: arr.length,
    totalMs: arr.reduce((a, b) => a + b, 0),
    avgMs: arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
  }));
}

function modeMatchStats(matchEndEvents) {
  const byMode = new Map();
  for (const e of matchEndEvents) {
    if (!byMode.has(e.mode)) byMode.set(e.mode, []);
    byMode.get(e.mode).push(e);
  }
  return [...byMode.entries()].map(([_id, arr]) => ({
    _id, count: arr.length,
    avgDurationMs: arr.reduce((a, b) => a + (b.durationMs || 0), 0) / arr.length,
    avgPlayers: arr.reduce((a, b) => a + (b.playerCount || 0), 0) / arr.length,
  }));
}

function dayPurchaseStats(purchaseEvents) {
  const byDay = new Map();
  for (const e of purchaseEvents) {
    if (!byDay.has(e.day)) byDay.set(e.day, { count: 0, shardsSpent: 0 });
    const rec = byDay.get(e.day);
    rec.count++; rec.shardsSpent += (e.cost || 0);
  }
  return [...byDay.entries()].map(([_id, v]) => ({ _id, ...v }));
}

function assemble({
  dayKeys, dauRows, sessionRows, matchStartRows, matchEndRows, mapRows,
  purchaseRows, premiumPurchaseRows, topCosmeticRows, topPremiumRows,
  modeJoinRows, newVsReturning,platformRows=[],eventTypeRows=[],
  sessionReasonRows=[],uniquePlayerRows=[],hourRows=[],retention=null,source,
}) {
  const dauMap = new Map(dauRows.map(r => [r._id, r.count]));
  const sessMap = new Map(sessionRows.map(r => [r._id, r]));
  const purchMap = new Map(purchaseRows.map(r => [r._id, r]));
  const premiumPurchMap = new Map((premiumPurchaseRows||[]).map(r => [r._id, r]));

  // matchStartRows keys differ between mongo ({day,mode}) and memory ('day|mode')
  const matchByDayMode = new Map();
  for (const r of matchStartRows) {
    const key = typeof r._id === 'object' ? `${r._id.day}|${r._id.mode}` : r._id;
    matchByDayMode.set(key, r.count);
  }

  const daily = dayKeys.map(dk => {
    const sess = sessMap.get(dk) || { sessions: 0, totalMs: 0, avgMs: 0 };
    const purch = purchMap.get(dk) || { count: 0, shardsSpent: 0 };
    const premiumPurch = premiumPurchMap.get(dk) || { count: 0 };
    const nvr = newVsReturning[dk] || { new: new Set(), returning: new Set() };
    return {
      day: dk,
      dau: dauMap.get(dk) || 0,
      newPlayers: nvr.new.size,
      returningPlayers: nvr.returning.size,
      sessions: sess.sessions,
      totalPlaytimeMs: sess.totalMs,
      avgSessionMs: sess.avgMs,
      matches: { ffa: matchByDayMode.get(`${dk}|ffa`) || 0, tdm: matchByDayMode.get(`${dk}|tdm`) || 0, ranked: matchByDayMode.get(`${dk}|ranked`) || 0, lms: matchByDayMode.get(`${dk}|lms`) || 0 },
      purchases: purch.count + premiumPurch.count,
      cosmeticPurchases: purch.count,
      premiumPurchases: premiumPurch.count,
      shardsSpent: purch.shardsSpent,
    };
  });

  const totals = daily.reduce((acc, d) => {
    acc.sessions += d.sessions; acc.totalPlaytimeMs += d.totalPlaytimeMs;
    acc.purchases += d.purchases;
    acc.cosmeticPurchases += d.cosmeticPurchases;
    acc.premiumPurchases += d.premiumPurchases;
    acc.shardsSpent += d.shardsSpent;
    acc.matches += d.matches.ffa + d.matches.tdm + d.matches.ranked + d.matches.lms;
    return acc;
  }, {
    sessions:0,totalPlaytimeMs:0,purchases:0,cosmeticPurchases:0,
    premiumPurchases:0,shardsSpent:0,matches:0,
  });

  const modeByMatchEnd = new Map(matchEndRows.map(r => [r._id, r]));

  return {
    source, generatedAt: Date.now(),
    daily,
    totals: {
      ...totals,
      avgSessionMs: totals.sessions ? totals.totalPlaytimeMs / totals.sessions : 0,
      dauToday: daily.length ? daily[daily.length - 1].dau : 0,
    },
    modePopularity: modeJoinRows.map(r => ({ mode: r._id, joins: r.count })),
    platformPopularity:platformRows.map(r=>({platform:r._id||'web',joins:r.count})),
    activityByHour:Array.from({length:24},(_,hour)=>({
      hour,
      joins:hourRows.find(row=>Number(row._id)===hour)?.count||0,
    })),
    uniquePlayersRange:uniquePlayerRows[0]?.count||0,
    retention:retention||{
      day1:{eligible:0,returned:0,percent:0},
      day7:{eligible:0,returned:0,percent:0},
    },
    funnel:Object.fromEntries(eventTypeRows.map(row=>[row._id,row.count])),
    sessionEndReasons:sessionReasonRows
      .map(row=>({reason:row._id||'unknown',count:row.count}))
      .sort((a,b)=>b.count-a.count),
    modeMatchStats: ['ffa', 'tdm', 'ranked', 'lms'].map(m => ({
      mode: m,
      matches: modeByMatchEnd.get(m)?.count || 0,
      avgDurationMs: modeByMatchEnd.get(m)?.avgDurationMs || 0,
      avgPlayers: modeByMatchEnd.get(m)?.avgPlayers || 0,
    })),
    mapPopularity: mapRows.map(r => ({ mapId: r._id, count: r.count })),
    topCosmetics: topCosmeticRows.map(r => {
      const [category, id] = typeof r._id === 'object' ? [r._id.category, r._id.id] : r._id.split('|');
      return { category, id, count: r.count };
    }),
    topShopItems: [
      ...topCosmeticRows.map(r => {
        const [category,id]=typeof r._id==='object'
          ?[r._id.category,r._id.id]:String(r._id||'').split('|');
        return {category:category||'cosmetic',id:id||'unknown',count:r.count};
      }),
      ...(topPremiumRows||[]).map(r=>({
        category:'premium',
        id:String(r._id||'unknown'),
        count:r.count,
      })),
    ].sort((a,b)=>b.count-a.count).slice(0,10),
  };
}

module.exports = { init, logEvent, getSummary, deletePlayerData };
