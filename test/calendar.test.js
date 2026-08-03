'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getIsoWeekKey, getNextMonday } = require('../calendar');

test('ISO week keys stay correct across calendar-year boundaries', () => {
  assert.equal(getIsoWeekKey(new Date('2024-12-31T23:00:00Z')),'2025-W01');
  assert.equal(getIsoWeekKey(new Date('2021-01-01T12:00:00Z')),'2020-W53');
  assert.equal(getIsoWeekKey(new Date('2026-07-28T00:00:00Z')),'2026-W31');
});

test('next weekly reset is the following Monday at UTC midnight', () => {
  assert.equal(new Date(getNextMonday(new Date('2026-07-26T18:00:00Z'))).toISOString(),'2026-07-27T00:00:00.000Z');
  assert.equal(new Date(getNextMonday(new Date('2026-07-27T00:00:00Z'))).toISOString(),'2026-08-03T00:00:00.000Z');
});
