'use strict';

const crypto = require('crypto');

const ALLOWED_TYPES = new Set(['news', 'update', 'event', 'maintenance']);
const MAX_PUBLIC_ANNOUNCEMENTS = 50;

let db = null;
let memory = [];

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

function validateAnnouncement(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const value = {};
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'title')) {
    value.title = cleanText(input.title, 80);
    if (!value.title) return { ok: false, reason: 'title_required' };
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'body')) {
    value.body = cleanText(input.body, 2000);
    if (!value.body) return { ok: false, reason: 'body_required' };
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'type')) {
    value.type = ALLOWED_TYPES.has(input.type) ? input.type : 'news';
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'published')) {
    value.published = input.published === true;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'pinned')) {
    value.pinned = input.pinned === true;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'important')) {
    value.important = input.important === true;
  }

  if (partial && Object.keys(value).length === 0) {
    return { ok: false, reason: 'no_changes' };
  }
  return { ok: true, value };
}

function toPublic(doc) {
  return {
    id: String(doc._id),
    title: doc.title,
    body: doc.body,
    type: doc.type || 'news',
    pinned: doc.pinned === true,
    important: doc.important === true,
    publishedAt: doc.publishedAt || doc.createdAt,
    updatedAt: doc.updatedAt || doc.createdAt,
  };
}

function toAdmin(doc) {
  return {
    ...toPublic(doc),
    published: doc.published === true,
    createdAt: doc.createdAt,
  };
}

function compareDocs(a, b) {
  if (a.important !== b.important) return a.important ? -1 : 1;
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const aDate = a.publishedAt || a.createdAt || '';
  const bDate = b.publishedAt || b.createdAt || '';
  return bDate.localeCompare(aDate);
}

async function init(database) {
  db = database || null;
  if (!db) return;
  const col = db.collection('announcements');
  await Promise.all([
    col.createIndex({ published: 1, important: -1, pinned: -1, publishedAt: -1 }),
    col.createIndex({ updatedAt: -1 }),
  ]);
}

async function listPublic() {
  let docs;
  if (db) {
    docs = await db.collection('announcements')
      .find({ published: true })
      .sort({ important: -1, pinned: -1, publishedAt: -1, createdAt: -1 })
      .limit(MAX_PUBLIC_ANNOUNCEMENTS)
      .toArray();
  } else {
    docs = memory.filter(item => item.published).sort(compareDocs).slice(0, MAX_PUBLIC_ANNOUNCEMENTS);
  }
  return docs.map(toPublic);
}

async function listAdmin() {
  let docs;
  if (db) {
    docs = await db.collection('announcements')
      .find({})
      .sort({ updatedAt: -1 })
      .limit(200)
      .toArray();
  } else {
    docs = memory.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return docs.map(toAdmin);
}

async function create(input) {
  const checked = validateAnnouncement(input);
  if (!checked.ok) return checked;

  const now = new Date().toISOString();
  const doc = {
    _id: crypto.randomUUID(),
    ...checked.value,
    createdAt: now,
    updatedAt: now,
    publishedAt: checked.value.published ? now : null,
  };
  if (db) await db.collection('announcements').insertOne(doc);
  else memory.push(doc);
  return { ok: true, announcement: toAdmin(doc) };
}

async function update(id, input) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'invalid_id' };
  const checked = validateAnnouncement(input, { partial: true });
  if (!checked.ok) return checked;

  const now = new Date().toISOString();
  const patch = { ...checked.value, updatedAt: now };

  if (db) {
    const current = await db.collection('announcements').findOne({ _id: id });
    if (!current) return { ok: false, reason: 'not_found' };
    if (patch.published === true && !current.published) patch.publishedAt = now;
    if (patch.published === false) patch.publishedAt = null;
    const result = await db.collection('announcements').findOneAndUpdate(
      { _id: id },
      { $set: patch },
      { returnDocument: 'after' }
    );
    const doc = result && result.value ? result.value : result;
    return { ok: true, announcement: toAdmin(doc) };
  }

  const index = memory.findIndex(item => item._id === id);
  if (index < 0) return { ok: false, reason: 'not_found' };
  const current = memory[index];
  if (patch.published === true && !current.published) patch.publishedAt = now;
  if (patch.published === false) patch.publishedAt = null;
  memory[index] = { ...current, ...patch };
  return { ok: true, announcement: toAdmin(memory[index]) };
}

async function remove(id) {
  if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'invalid_id' };
  if (db) {
    const result = await db.collection('announcements').deleteOne({ _id: id });
    return result.deletedCount ? { ok: true } : { ok: false, reason: 'not_found' };
  }
  const index = memory.findIndex(item => item._id === id);
  if (index < 0) return { ok: false, reason: 'not_found' };
  memory.splice(index, 1);
  return { ok: true };
}

function resetForTests() {
  db = null;
  memory = [];
}

module.exports = {
  init,
  listPublic,
  listAdmin,
  create,
  update,
  remove,
  validateAnnouncement,
  resetForTests,
};
