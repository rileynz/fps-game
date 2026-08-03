'use strict';

const DAILY_REWARDS = [50, 75, 100];
const WEEKLY_REWARDS = [250, 350, 500];

const DAILY_TYPES = [
  { id:'kills',        category:'combat',    label:'Get {n} eliminations',                    unit:'eliminations', values:[5,8,12] },
  { id:'rounds',       category:'play',      label:'Play {n} rounds',                         unit:'rounds',       values:[2,3,4] },
  { id:'win_round',    category:'placement', label:'Win {n} round(s)',                        unit:'wins',         values:[1,2,2] },
  { id:'ranked',       category:'mode',      label:'Play {n} competitive Ranked rounds',      unit:'rounds',       values:[1,2,3] },
  { id:'score',        category:'score',     label:'Earn {n} challenge points',               unit:'points',       values:[250,450,650] },
  { id:'kill_streak',  category:'streak',    label:'Get {n} eliminations in one round',        unit:'eliminations', values:[3,4,6], best:true },
  { id:'damage',       category:'damage',    label:'Deal {n} challenge damage',               unit:'damage',       values:[350,650,1000] },
  { id:'survive',      category:'survival',  label:'Finish {n} round(s) without being defeated', unit:'rounds',     values:[1,2,3] },
  { id:'no_death_kills', category:'survival',label:'Get {n} eliminations without being defeated', unit:'eliminations', values:[2,3,5], best:true },
  { id:'big_round',    category:'streak',    label:'Get {n}+ eliminations in two rounds',      unit:'rounds',       values:[3,4,6], requiredRounds:2 },
  { id:'daily_login',  category:'play',      label:'Finish one round today',                  unit:'round',        values:[1] },
  { id:'ranked_win',   category:'placement', label:'Win {n} competitive Ranked round(s)',      unit:'wins',         values:[1,1,2] },
  { id:'ffa_win',      category:'placement', label:'Win {n} Free For All round(s)',            unit:'wins',         values:[1,2,2] },
  { id:'lms_rounds',   category:'mode',      label:'Play {n} Last Stand round(s)',             unit:'rounds',       values:[1,2,3] },
  { id:'lms_win',      category:'placement', label:'Win {n} Last Stand round(s)',              unit:'wins',         values:[1,1,2] },
  { id:'low_deaths_rounds', category:'survival', label:'Finish {n} rounds with at most one defeat', unit:'rounds', values:[2,3,4] },
  { id:'mode_variety', category:'variety',   label:'Play {n} different public modes',          unit:'modes',        values:[2,3] },
  { id:'map_variety',  category:'variety',   label:'Play on {n} different maps',               unit:'maps',         values:[2,3,4] },
  { id:'comeback',     category:'placement', label:'Win after being defeated in {n} round(s)', unit:'wins',         values:[1,2,2] },
  { id:'top_three',    category:'placement', label:'Finish in the top 3 in {n} round(s)',       unit:'rounds',       values:[1,2,3] },
  { id:'pistol_kills', category:'weapon',    weapon:'pistol',  label:'Get {n} Pistol eliminations',  unit:'eliminations', values:[3,5,8] },
  { id:'shotgun_kills',category:'weapon',    weapon:'shotgun', label:'Get {n} Shotgun eliminations', unit:'eliminations', values:[3,5,8] },
  { id:'smg_kills',    category:'weapon',    weapon:'smg',     label:'Get {n} SMG eliminations',     unit:'eliminations', values:[4,7,10] },
  { id:'sniper_kills', category:'weapon',    weapon:'sniper',  label:'Get {n} Sniper eliminations',  unit:'eliminations', values:[2,4,6] },
  { id:'ricochet_kills', category:'skill',   label:'Get {n} bank-shot eliminations',                  unit:'eliminations', values:[2,3,5] },
];

const WEEKLY_TYPES = [
  { id:'weekly_kills',       category:'combat',    label:'Get {n} eliminations this week',             unit:'eliminations', values:[40,60,90] },
  { id:'weekly_rounds',      category:'play',      label:'Play {n} rounds this week',                  unit:'rounds',       values:[12,18,25] },
  { id:'weekly_wins',        category:'placement', label:'Win {n} competitive rounds this week',       unit:'wins',         values:[4,6,9] },
  { id:'weekly_score',       category:'score',     label:'Earn {n} challenge points this week',        unit:'points',       values:[3500,5500,8000] },
  { id:'weekly_damage',      category:'damage',    label:'Deal {n} challenge damage this week',        unit:'damage',       values:[4000,6500,9500] },
  { id:'weekly_survive',     category:'survival',  label:'Finish {n} rounds without being defeated',  unit:'rounds',       values:[5,8,12] },
  { id:'weekly_ranked',      category:'mode',      label:'Play {n} competitive Ranked rounds',         unit:'rounds',       values:[5,8,12] },
  { id:'weekly_lms',         category:'mode',      label:'Play {n} Last Stand rounds',                  unit:'rounds',       values:[5,8,12] },
  { id:'weekly_top_three',   category:'placement', label:'Finish in the top 3 in {n} rounds',          unit:'rounds',       values:[5,8,12] },
  { id:'weekly_maps',        category:'variety',   label:'Play on all {n} maps this week',              unit:'maps',         values:[5] },
  { id:'weekly_modes',       category:'variety',   label:'Play all {n} public modes this week',         unit:'modes',        values:[3] },
  { id:'weekly_big_rounds',  category:'streak',    label:'Get 5+ eliminations in {n} rounds',           unit:'rounds',       values:[4,6,8], killThreshold:5 },
  { id:'weekly_pistol',      category:'weapon', weapon:'pistol',  label:'Get {n} Pistol eliminations this week',  unit:'eliminations', values:[15,25,35] },
  { id:'weekly_shotgun',     category:'weapon', weapon:'shotgun', label:'Get {n} Shotgun eliminations this week', unit:'eliminations', values:[15,25,35] },
  { id:'weekly_smg',         category:'weapon', weapon:'smg',     label:'Get {n} SMG eliminations this week',     unit:'eliminations', values:[18,28,40] },
  { id:'weekly_sniper',      category:'weapon', weapon:'sniper',  label:'Get {n} Sniper eliminations this week',  unit:'eliminations', values:[12,20,30] },
  { id:'weekly_ricochet',    category:'skill', label:'Get {n} bank-shot eliminations this week', unit:'eliminations', values:[12,20,30] },
];

function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRand(seedValue) {
  let state = hashSeed(seedValue) || 1;
  return function random() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled(items, random) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makeChallenge(type, slot, random, rewards, scope) {
  const rolledValue = type.values[Math.floor(random() * type.values.length)];
  const target = type.requiredRounds || rolledValue;
  return {
    id: `${scope}_${type.id}_${slot}`,
    type: type.id,
    category: type.category,
    label: type.label.replace('{n}', rolledValue),
    target,
    unit: type.unit,
    points: rewards[slot],
    weapon: type.weapon,
    killThreshold: type.requiredRounds ? rolledValue : type.killThreshold,
  };
}

function generateSet(key, pool, rewards, scope) {
  const random = seededRand(`${scope}:${key}`);
  const candidates = shuffled(pool, random);
  const picked = [];
  const categories = new Set();
  for (const type of candidates) {
    if (categories.has(type.category)) continue;
    picked.push(type);
    categories.add(type.category);
    if (picked.length === rewards.length) break;
  }
  return picked.map((type, index) => makeChallenge(type, index, random, rewards, scope));
}

function generateDailyChallenges(dayKey) {
  return generateSet(dayKey, DAILY_TYPES, DAILY_REWARDS, 'daily');
}

function generateWeeklyChallenges(weekKey) {
  return generateSet(weekKey, WEEKLY_TYPES, WEEKLY_REWARDS, 'weekly');
}

function generateRerolledChallenge(dayKey, playerName, slot, existing) {
  const excludedTypes = new Set(existing.map(challenge => challenge.type));
  const excludedCategories = new Set(
    existing.filter((_, index) => index !== slot).map(challenge => challenge.category)
  );
  const random = seededRand(`reroll:${dayKey}:${String(playerName).toLowerCase()}:${slot}`);
  const candidates = shuffled(DAILY_TYPES, random).filter(type =>
    !excludedTypes.has(type.id) && !excludedCategories.has(type.category)
  );
  if (!candidates.length) return null;
  return makeChallenge(candidates[0], slot, random, DAILY_REWARDS, 'daily-reroll');
}

function addUnique(list, value) {
  if (typeof value !== 'string' || !value || list.includes(value)) return;
  list.push(value);
}

function updateChallengeMemory(memory, stats) {
  if (!Array.isArray(memory.modesPlayed)) memory.modesPlayed = [];
  if (!Array.isArray(memory.mapsPlayed)) memory.mapsPlayed = [];
  addUnique(memory.modesPlayed, stats.mode);
  addUnique(memory.mapsPlayed, stats.mapId);
}

function progressChallenge(challenge, previous, stats, memory) {
  const kills = Number(stats.challengeKills) || 0;
  const damage = Number(stats.challengeDamage) || 0;
  const score = Number(stats.challengeScore) || 0;
  const weaponKills = stats.challengeWeaponKills || {};
  const competitive = !!stats.competitiveRound;
  let next = Number(previous) || 0;

  switch (challenge.type) {
    case 'kills':
    case 'weekly_kills':
      next += kills;
      break;
    case 'rounds':
    case 'daily_login':
    case 'weekly_rounds':
      next += 1;
      break;
    case 'win_round':
    case 'weekly_wins':
      next += competitive && stats.won ? 1 : 0;
      break;
    case 'ranked':
    case 'weekly_ranked':
      next += competitive && stats.isRanked ? 1 : 0;
      break;
    case 'score':
    case 'weekly_score':
      next += score;
      break;
    case 'kill_streak':
      next = Math.max(next, kills);
      break;
    case 'damage':
    case 'weekly_damage':
      next += damage;
      break;
    case 'survive':
    case 'weekly_survive':
      next += stats.survivedRound ? 1 : 0;
      break;
    case 'no_death_kills':
      if (stats.survivedRound) next = Math.max(next, kills);
      break;
    case 'big_round':
    case 'weekly_big_rounds':
      next += kills >= (challenge.killThreshold || Infinity) ? 1 : 0;
      break;
    case 'ranked_win':
      next += competitive && stats.isRanked && stats.won ? 1 : 0;
      break;
    case 'ffa_win':
      next += competitive && stats.isFfa && stats.won ? 1 : 0;
      break;
    case 'lms_rounds':
    case 'weekly_lms':
      next += stats.isLms ? 1 : 0;
      break;
    case 'lms_win':
      next += competitive && stats.isLms && stats.won ? 1 : 0;
      break;
    case 'low_deaths_rounds':
      next += (stats.deaths || 0) <= 1 ? 1 : 0;
      break;
    case 'mode_variety':
    case 'weekly_modes':
      next = Math.max(next, memory.modesPlayed.length);
      break;
    case 'map_variety':
    case 'weekly_maps':
      next = Math.max(next, memory.mapsPlayed.length);
      break;
    case 'comeback':
      next += competitive && stats.won && (stats.deaths || 0) > 0 ? 1 : 0;
      break;
    case 'top_three':
    case 'weekly_top_three':
      next += competitive && (stats.placement || Infinity) <= 3 ? 1 : 0;
      break;
    case 'ricochet_kills':
    case 'weekly_ricochet':
      next += Number(stats.challengeRicochetKills)||0;
      break;
    default:
      if (challenge.weapon) next += Number(weaponKills[challenge.weapon]) || 0;
      break;
  }

  return Math.min(challenge.target, Math.max(0, next));
}

module.exports = {
  DAILY_BONUS_POINTS: 50,
  WEEKLY_BONUS_POINTS: 300,
  DAILY_TYPES,
  WEEKLY_TYPES,
  generateDailyChallenges,
  generateWeeklyChallenges,
  generateRerolledChallenge,
  updateChallengeMemory,
  progressChallenge,
};
