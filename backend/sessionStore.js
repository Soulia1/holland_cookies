import { randomBytes, createHmac } from 'node:crypto';
import { putSession, readSessionRecord, deleteSession, purgeExpiredSessions } from './repo/system.js';

/**
 * Session tokens.
 *
 * The token goes to the browser; only an HMAC of it is ever stored. A read of
 * the sessions collection is therefore not a list of working credentials, which
 * matters more with Firestore than it did with a local SQLite file — the data is
 * now somewhere a console, an export or a misconfigured rule could expose it.
 *
 * These became async in the Firestore migration. Everything that reads a session
 * is now an async middleware; Express 5 handles a rejected promise from
 * middleware as an error, so a Firestore outage surfaces as a 503 rather than an
 * unhandled rejection.
 */

const digest = (value) => {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_KEY;
  if (!secret) throw new Error('Session secret is required');
  return createHmac('sha256', secret).update(value).digest('hex');
};

/** How often to opportunistically sweep expired rows, in milliseconds. */
const PURGE_INTERVAL_MS = 5 * 60 * 1000;
let lastPurge = 0;

export async function createSession(kind, subject, ttlSeconds) {
  const token = randomBytes(32).toString('base64url');
  await putSession(digest(token), kind, subject, Date.now() + ttlSeconds * 1000);

  // Housekeeping, not correctness: expiry is enforced on read. Failures are
  // swallowed deliberately — a full sessions collection must never stop
  // somebody signing in.
  if (Date.now() - lastPurge > PURGE_INTERVAL_MS) {
    lastPurge = Date.now();
    purgeExpiredSessions().catch(() => {});
  }
  return token;
}

export async function readStoredSession(token, kind) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return readSessionRecord(digest(token), kind);
}

export async function revokeSession(token) {
  if (typeof token === 'string' && token.length === 43) await deleteSession(digest(token));
}

export function cookieOptions(ttlSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds * 1000,
  };
}
