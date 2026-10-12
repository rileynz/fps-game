'use strict';

// ISO weeks use Monday as day one, and week one is the week containing
// January 4. Work in UTC so a server timezone change cannot split players
// across two different challenge/leaderboard weeks.
function getIsoWeekKey(value = new Date()) {
  const source = value instanceof Date ? value : new Date(value);
  const date = new Date(Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth(),
    source.getUTCDate()
  ));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function getNextMonday(value = new Date()) {
  const source = value instanceof Date ? value : new Date(value);
  const day = source.getUTCDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  return Date.UTC(
    source.getUTCFullYear(),
    source.getUTCMonth(),
    source.getUTCDate() + daysUntilMonday
  );
}

module.exports = { getIsoWeekKey, getNextMonday };
