'use strict';

const crypto=require('crypto');
const {promisify}=require('util');
const scrypt=promisify(crypto.scrypt);

const PASSWORD_MIN_LENGTH=10;
const PASSWORD_MAX_LENGTH=128;

function normalizeEmail(value) {
  const email=String(value||'').trim().toLowerCase();
  if (email.length<5||email.length>254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function validPassword(value) {
  return typeof value==='string'
    && value.length>=PASSWORD_MIN_LENGTH
    && value.length<=PASSWORD_MAX_LENGTH
    && /[A-Za-z]/.test(value)
    && /[0-9]/.test(value);
}

async function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')) {
  if (!validPassword(password)) throw new Error('invalid_password');
  const derived=await scrypt(password,salt,64);
  return {salt,hash:Buffer.from(derived).toString('hex')};
}

async function verifyPassword(password,salt,expectedHex) {
  if (!validPassword(password)||typeof salt!=='string'||typeof expectedHex!=='string') return false;
  const derived=Buffer.from(await scrypt(password,salt,64));
  const expected=Buffer.from(expectedHex,'hex');
  return expected.length===derived.length&&crypto.timingSafeEqual(expected,derived);
}

function randomNumericCode() {
  return String(crypto.randomInt(0,1000000)).padStart(6,'0');
}

function randomToken(bytes=32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(value) {
  return crypto.createHash('sha256').update(String(value||'')).digest('hex');
}

function safeEqualHash(value,expectedHash) {
  if (typeof expectedHash!=='string'||!/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  const actual=Buffer.from(hashToken(value),'hex');
  const expected=Buffer.from(expectedHash,'hex');
  return crypto.timingSafeEqual(actual,expected);
}

function parseCookies(header) {
  const result={};
  for (const part of String(header||'').split(';')) {
    const index=part.indexOf('=');
    if (index<1) continue;
    const key=part.slice(0,index).trim();
    try{result[key]=decodeURIComponent(part.slice(index+1).trim());}catch{result[key]='';}
  }
  return result;
}

function sessionCookie(token,{secure=true,persistent=true,maxAgeSeconds=30*24*60*60}={}) {
  const fields=[
    `arena_session=${encodeURIComponent(token||'')}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) fields.push('Secure');
  if (persistent&&token) fields.push(`Max-Age=${Math.max(0,Math.floor(maxAgeSeconds))}`);
  if (!token) fields.push('Max-Age=0');
  return fields.join('; ');
}

function maskEmail(email) {
  const normalized=normalizeEmail(email);
  if (!normalized) return '';
  const [local,domain]=normalized.split('@');
  return `${local.slice(0,1)}${'*'.repeat(Math.min(6,Math.max(2,local.length-1)))}@${domain}`;
}

module.exports={
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  normalizeEmail,
  validPassword,
  hashPassword,
  verifyPassword,
  randomNumericCode,
  randomToken,
  hashToken,
  safeEqualHash,
  parseCookies,
  sessionCookie,
  maskEmail,
};
