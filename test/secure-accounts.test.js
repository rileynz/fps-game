'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=path.join(__dirname,'..');
const accounts=require(path.join(root,'secure-accounts'));

test('passwords require useful length plus letters and numbers',()=>{
  assert.equal(accounts.validPassword('short1'),false);
  assert.equal(accounts.validPassword('onlyletterslong'),false);
  assert.equal(accounts.validPassword('123456789012'),false);
  assert.equal(accounts.validPassword('arena-player-2048'),true);
});

test('scrypt password records verify without storing the password',async()=>{
  const record=await accounts.hashPassword('arena-player-2048');
  assert.notEqual(record.hash,'arena-player-2048');
  assert.equal(await accounts.verifyPassword('arena-player-2048',record.salt,record.hash),true);
  assert.equal(await accounts.verifyPassword('arena-player-2049',record.salt,record.hash),false);
});

test('session cookies are opaque, HttpOnly, secure, and same-site',()=>{
  const token=accounts.randomToken();
  const cookie=accounts.sessionCookie(token,{secure:true,persistent:true,maxAgeSeconds:600});
  assert.match(cookie,/arena_session=/);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/Secure/);
  assert.match(cookie,/SameSite=Lax/);
  assert.match(cookie,/Max-Age=600/);
  assert.equal(accounts.parseCookies(cookie).arena_session,token);
});

test('verification tokens use timing-safe hashed comparison',()=>{
  const code=accounts.randomNumericCode();
  const hash=accounts.hashToken(code);
  assert.match(code,/^[0-9]{6}$/);
  assert.equal(accounts.safeEqualHash(code,hash),true);
  assert.equal(accounts.safeEqualHash('000000',hash),code==='000000');
});
