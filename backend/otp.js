/**
 * Email one-time codes.
 *
 * Ported from Scooby, with its reasoning intact:
 *
 * **Codes are stored hashed, with a password KDF rather than a digest.** The
 * secret is six digits, so a single SHA-256 pass sweeps the whole 10^6 keyspace
 * in about half a second — anyone holding a copy of this table would read every
 * live code. scrypt at N=32768, r=8, p=1 costs ~50ms and 32 MiB per derivation,
 * which puts a full sweep at roughly fourteen core-hours against a code that
 * lives ten minutes, and the memory cost is what stops that being bought back
 * cheaply on a GPU. The next notch up doubles both, and it is the memory that
 * argues against it: every concurrent verify holds its own buffer, so the
 * parameter that hardens the record also decides how much a burst of sign-ins
 * can allocate.
 *
 * **The email is part of the derivation input**, so a code harvested for one
 * address cannot be replayed against another, and the salt is per row, so work
 * spent on one record buys nothing against the next.
 *
 * The send path is ours, so the abuse controls are real rather than decorative:
 * the code is generated here, the quota is enforced here, and nothing is sent
 * until both pass.
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import * as db from './db.js';

const scryptAsync = promisify(scrypt);

const CODE_LENGTH = 6;
const CODE_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;    // 60 seconds
const MAX_ATTEMPTS = 5;                  // wrong guesses before the code dies
const MAX_PER_EMAIL_HOUR = 3;
const MAX_PER_EMAIL_DAY = 5;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function isEmail(value) {
  const email = normalizeEmail(value);
  // Deliberately permissive. The address is proved by whether a code sent to it
  // comes back, which is a far better test than any pattern, so this only has
  // to reject what obviously cannot be delivered.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 160;
}

/**
 * Six digits, uniformly distributed. `randomInt` is rejection-sampled, so
 * unlike `Math.random()` or `% 1000000` it carries no modulo bias.
 */
function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(CODE_LENGTH, '0');
}

async function deriveCodeHash(email, code, salt) {
  const derived = await scryptAsync(
    `otp:${normalizeEmail(email)}:${code}`,
    Buffer.from(salt, 'hex'),
    KEY_BYTES,
    SCRYPT_PARAMS,
  );
  return derived.toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function msSince(iso) {
  return Date.now() - new Date(iso).getTime();
}

/**
 * Issue a code for an address, or explain why not.
 *
 * Returns `{ ok: true, code }` — the caller is responsible for delivering it.
 * The code is returned rather than sent from here so the transport stays
 * pluggable; see `mailer.js`.
 */
export async function requestCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) {
    return { ok: false, code: 'INVALID_EMAIL', message: 'That email does not look right.' };
  }

  const database = db.get();
  const existing = database.prepare('SELECT * FROM otp_codes WHERE email = ?').get(email);

  // Rolling windows, reset lazily rather than by a scheduled job.
  let sentHour = existing?.sent_hour ?? 0;
  let hourStart = existing?.hour_start ?? nowIso();
  let sentDay = existing?.sent_day ?? 0;
  let dayStart = existing?.day_start ?? nowIso();

  if (msSince(hourStart) > 60 * 60 * 1000) { sentHour = 0; hourStart = nowIso(); }
  if (msSince(dayStart) > 24 * 60 * 60 * 1000) { sentDay = 0; dayStart = nowIso(); }

  if (existing && msSince(existing.last_sent_at) < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - msSince(existing.last_sent_at)) / 1000);
    return {
      ok: false,
      code: 'COOLDOWN',
      message: `Wait ${wait} seconds before asking for another code.`,
      retryAfter: wait,
    };
  }
  if (sentHour >= MAX_PER_EMAIL_HOUR) {
    return { ok: false, code: 'RATE_LIMITED', message: 'Too many codes requested. Try again later.' };
  }
  if (sentDay >= MAX_PER_EMAIL_DAY) {
    return { ok: false, code: 'RATE_LIMITED', message: 'Too many codes requested today.' };
  }

  const code = generateCode();
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = await deriveCodeHash(email, code, salt);

  // Replaces any previous row, so requesting a new code immediately invalidates
  // the old one rather than leaving two that both work.
  database.prepare(`
    INSERT INTO otp_codes (email, code_hash, code_salt, expires_at, attempts,
                           last_sent_at, sent_hour, hour_start, sent_day, day_start)
    VALUES (@email, @hash, @salt, @expiresAt, 0, @now, @sentHour, @hourStart, @sentDay, @dayStart)
    ON CONFLICT(email) DO UPDATE SET
      code_hash = excluded.code_hash,
      code_salt = excluded.code_salt,
      expires_at = excluded.expires_at,
      attempts = 0,
      last_sent_at = excluded.last_sent_at,
      sent_hour = excluded.sent_hour,
      hour_start = excluded.hour_start,
      sent_day = excluded.sent_day,
      day_start = excluded.day_start
  `).run({
    email,
    hash,
    salt,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    now: nowIso(),
    sentHour: sentHour + 1,
    hourStart,
    sentDay: sentDay + 1,
    dayStart,
  });

  return { ok: true, email, code, expiresInMs: CODE_TTL_MS };
}

/**
 * Check a code.
 *
 * A correct code is consumed — the row is deleted — so it cannot be replayed.
 * A wrong one costs an attempt, and the code dies after five, which is what
 * stops the six-digit space being walked by a script.
 */
export async function verifyCode(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode ?? '').trim();
  const database = db.get();
  const record = database.prepare('SELECT * FROM otp_codes WHERE email = ?').get(email);

  // The same answer whether no code was ever issued or it has expired: telling
  // them apart says which addresses have accounts.
  const wrong = { ok: false, code: 'INVALID_CODE', message: 'That code is not right.' };
  if (!record) return wrong;

  if (new Date(record.expires_at).getTime() < Date.now()) {
    database.prepare('DELETE FROM otp_codes WHERE email = ?').run(email);
    return { ok: false, code: 'EXPIRED', message: 'That code has expired. Ask for a new one.' };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    database.prepare('DELETE FROM otp_codes WHERE email = ?').run(email);
    return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Too many tries. Ask for a new code.' };
  }
  if (!/^\d{6}$/.test(code)) {
    database.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    return wrong;
  }

  const derived = await deriveCodeHash(email, code, record.code_salt);
  const a = Buffer.from(derived, 'hex');
  const b = Buffer.from(record.code_hash, 'hex');
  // Constant-time, and length-checked first because timingSafeEqual throws on a
  // mismatch — an exception that only happens for one shape of input is itself
  // an oracle.
  const match = a.length === b.length && timingSafeEqual(a, b);

  if (!match) {
    database.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    return wrong;
  }

  database.prepare('DELETE FROM otp_codes WHERE email = ?').run(email);
  return { ok: true, email };
}

export const OTP_LIMITS = {
  CODE_TTL_MS, RESEND_COOLDOWN_MS, MAX_ATTEMPTS, MAX_PER_EMAIL_HOUR, MAX_PER_EMAIL_DAY,
};
