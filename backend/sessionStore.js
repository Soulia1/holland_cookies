import { randomBytes, createHmac } from 'node:crypto';
import * as db from './db.js';
const digest = value => {
  const secret=process.env.JWT_SECRET || process.env.ADMIN_KEY;
  if(!secret) throw new Error('Session secret is required');
  return createHmac('sha256',secret).update(value).digest('hex');
};
export function createSession(kind, subject, ttlSeconds) {
  const token = randomBytes(32).toString('base64url');
  const database = db.get();
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  database.prepare('INSERT INTO sessions (token_hash, kind, subject, expires_at) VALUES (?, ?, ?, ?)')
    .run(digest(token),kind,String(subject),Date.now()+ttlSeconds*1000);
  return token;
}
export function readStoredSession(token,kind) {
  if(typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.get().prepare('SELECT subject FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?').get(digest(token),kind,Date.now()) || null;
}
export function revokeSession(token) {
  if(typeof token==='string' && token.length===43) db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
}
export function cookieOptions(ttlSeconds) {
  return {httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:ttlSeconds*1000};
}
