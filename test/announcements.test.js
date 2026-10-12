'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const announcements = require('../announcements');
const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test.beforeEach(() => announcements.resetForTests());

test('draft announcements are hidden from players until published', async () => {
  const created = await announcements.create({
    title: 'Patch 2.1',
    body: 'Weapon balance changes are ready.',
    type: 'update',
    published: false,
  });
  assert.equal(created.ok, true);
  assert.deepEqual(await announcements.listPublic(), []);

  const published = await announcements.update(created.announcement.id, { published: true });
  assert.equal(published.ok, true);
  assert.equal((await announcements.listPublic())[0].title, 'Patch 2.1');
});

test('input is trimmed, limited and uses a safe announcement type', async () => {
  const result = await announcements.create({
    title: `  ${'A'.repeat(100)}  `,
    body: '  Hello players  ',
    type: 'unknown',
    published: true,
  });
  assert.equal(result.announcement.title.length, 80);
  assert.equal(result.announcement.body, 'Hello players');
  assert.equal(result.announcement.type, 'news');
});

test('pinned announcements appear before newer unpinned announcements', async () => {
  await announcements.create({ title: 'Newer', body: 'Second', published: true });
  await announcements.create({ title: 'Important', body: 'First', published: true, pinned: true });
  const publicItems = await announcements.listPublic();
  assert.deepEqual(publicItems.map(item => item.title), ['Important', 'Newer']);
});

test('important announcements appear before pinned announcements and are public', async () => {
  await announcements.create({
    title: 'Pinned',
    body: 'Pinned news',
    published: true,
    pinned: true,
  });
  await announcements.create({
    title: 'Service notice',
    body: 'Important news',
    published: true,
    important: true,
  });
  const publicItems = await announcements.listPublic();
  assert.deepEqual(publicItems.map(item => item.title), ['Service notice', 'Pinned']);
  assert.equal(publicItems[0].important, true);
});

test('empty and malformed announcements are rejected', async () => {
  assert.deepEqual(await announcements.create(null), { ok: false, reason: 'invalid_payload' });
  assert.deepEqual(
    await announcements.create({ title: ' ', body: 'Body' }),
    { ok: false, reason: 'title_required' }
  );
  assert.deepEqual(
    await announcements.create({ title: 'Title', body: ' ' }),
    { ok: false, reason: 'body_required' }
  );
});

test('announcements can be edited and deleted', async () => {
  const created = await announcements.create({ title: 'Old', body: 'Text', published: true });
  const edited = await announcements.update(created.announcement.id, { title: 'New' });
  assert.equal(edited.announcement.title, 'New');
  assert.equal((await announcements.listAdmin()).length, 1);
  assert.deepEqual(await announcements.remove(created.announcement.id), { ok: true });
  assert.deepEqual(await announcements.listAdmin(), []);
});

test('unread announcements never open the full panel without a player action', () => {
  assert.doesNotMatch(client, /scheduleAnnouncementAutoOpen/);
  assert.doesNotMatch(client, /announcementAutoOpenTimer/);
  assert.doesNotMatch(client, /setTimeout\(\(\)=>\{[\s\S]{0,300}window\.openAnnouncements\(\)/);
  assert.match(client, /id="btn-announcements" onclick="window\.openAnnouncements\(\)"/);
  assert.match(client, /id="menu-announcement-preview"[\s\S]*?onclick="window\.openAnnouncements\(\)"/);
});
