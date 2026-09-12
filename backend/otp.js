import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { collections, Timestamp } from './firestore.js';

/**
 * One-time sign-in codes.
 *
 * The code itself is NEVER stored. Only a scrypt hash of it with a per-row salt,
 * so a copy of this collection — an export, a console, a leaked backup — is not
 * a list of working sign-in credentials.
 *
 * ## What the Firestore migration had to rebuild
 *
 * The SQLite version reserved a verification attempt with one atomic statement:
 *
 *     UPDATE otp_codes SET attempts = attempts + 1
 *      WHERE email = ? AND attempts < ? AND expires_at > ? AND code_hash <> ''
 *      RETURNING code_hash, code_salt
 *
 * That did three things at once and could not be interleaved: it checked the
 * record was live, it burned an attempt, and it handed back the hash to compare
 * — all before any slow work began. Burning the attempt *first* is the whole
 * point, because the comparison involves a deliberately expensive KDF, and a
 * caller who can start a thousand concurrent verifications before any of them
 * finishes incrementing the counter has a thousand guesses, not five.
 *
 * Firestore has no conditional update and no RETURNING. The equivalent is a
 * transaction: read the record, decide, write the incremented count, return the
 * hash — and the KDF runs strictly *after* the transaction commits. Firestore
 * retries a transaction whose read was invalidated, so two concurrent
 * verifications cannot both observe `attempts = 4` and both proceed.
 */

const scryptAsync = promisify(scrypt);

const CODE_TTL_MS = 600000;
const RESEND_COOLDOWN_MS = 60000;
const MAX_ATTEMPTS = 5;
const MAX_PER_EMAIL_HOUR = 3;
const MAX_PER_EMAIL_DAY = 5;

/**
 * A concurrency gate on the KDF itself.
 *
 * scrypt at N=32768 is ~64 MiB and tens of milliseconds of CPU. Without a cap,
 * concurrent sign-in requests are a memory-exhaustion lever pointed at the
 * server by anyone who can reach the endpoint.
 */
let active = 0;
const MAX_CONCURRENT_KDF = 4;

export const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
export const isEmail = (value) => typeof value === 'string' && value.length <= 160
  && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

const wrong = () => ({ ok: false, code: 'INVALID_CODE', message: 'That code is not right.' });
const busy = () => ({ ok: false, code: 'BUSY', message: 'Try again shortly.', retryAfter: 5 });

async function derive(email, code, salt) {
  const key = await scryptAsync(`otp:${email}:${code}`, Buffer.from(salt, 'hex'), 32, {
    N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024,
  });
  return key.toString('hex');
}

const ms = (value) => (value?.toMillis ? value.toMillis() : Date.parse(value));

export async function requestCode(rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email)) return { ok: false, code: 'INVALID_EMAIL', message: 'That email does not look right.' };
  if (active >= MAX_CONCURRENT_KDF) return busy();

  const ref = collections.otpCodes().doc(email);
  const db = collections.otpCodes().firestore;
  const nowMs = Date.now();
  const salt = randomBytes(16).toString('hex');

  // Reserve the send quota atomically, before generating anything.
  const reservation = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const old = doc.exists ? doc.data() : null;

    if (old && nowMs - ms(old.lastSentAt) < RESEND_COOLDOWN_MS) {
      return { ok: false, code: 'COOLDOWN', message: 'Try again shortly.', retryAfter: 60 };
    }
    const hour = old && nowMs - ms(old.hourStart) < 3600000 ? old.sentHour : 0;
    const day = old && nowMs - ms(old.dayStart) < 86400000 ? old.sentDay : 0;
    if (hour >= MAX_PER_EMAIL_HOUR || day >= MAX_PER_EMAIL_DAY) {
      return { ok: false, code: 'RATE_LIMITED', message: 'Try again later.', retryAfter: 3600 };
    }

    tx.set(ref, {
      // Blank until the hash is computed below: a record with no hash cannot
      // verify, so a crash between here and there fails closed.
      codeHash: '',
      codeSalt: salt,
      expiresAt: Timestamp.fromMillis(nowMs + CODE_TTL_MS),
      attempts: 0,
      lastSentAt: Timestamp.fromMillis(nowMs),
      sentHour: hour + 1,
      hourStart: hour ? old.hourStart : Timestamp.fromMillis(nowMs),
      sentDay: day + 1,
      dayStart: day ? old.dayStart : Timestamp.fromMillis(nowMs),
    });
    return { ok: true };
  });

  if (!reservation.ok) return reservation;

  active += 1;
  try {
    const code = String(randomInt(0, 1000000)).padStart(6, '0');
    const codeHash = await derive(email, code, salt);

    // Attach the hash only to the record this call reserved. If a newer request
    // has already replaced the salt, this one lost the race and its code must
    // not become live.
    const attached = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().codeSalt !== salt) return false;
      tx.update(ref, { codeHash });
      return true;
    });
    if (!attached) return busy();

    return { ok: true, email, code, expiresInMs: CODE_TTL_MS };
  } finally {
    active -= 1;
  }
}

export async function verifyCode(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email) || typeof rawCode !== 'string' || !/^\d{6}$/.test(rawCode)) return wrong();
  if (active >= MAX_CONCURRENT_KDF) return busy();

  const ref = collections.otpCodes().doc(email);
  const db = collections.otpCodes().firestore;

  // Burn an attempt BEFORE the KDF runs. See the note at the top of this file.
  const record = await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return null;
    const row = doc.data();
    if (row.attempts >= MAX_ATTEMPTS) return null;
    if (row.expiresAt.toMillis() <= Date.now()) return null;
    if (!row.codeHash) return null;
    tx.update(ref, { attempts: row.attempts + 1 });
    return { codeHash: row.codeHash, codeSalt: row.codeSalt };
  });
  if (!record) return wrong();

  active += 1;
  try {
    const result = Buffer.from(await derive(email, rawCode, record.codeSalt), 'hex');
    const expected = Buffer.from(record.codeHash, 'hex');
    if (result.length !== expected.length || !timingSafeEqual(result, expected)) return wrong();

    // Consume it. Conditional on the hash still being the one just verified, so
    // a concurrent request that replaced the code cannot have its new code
    // consumed by this older success.
    const consumed = await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists || doc.data().codeHash !== record.codeHash) return false;
      if (doc.data().expiresAt.toMillis() <= Date.now()) return false;
      // The row is retained rather than deleted, so signing in cannot reset the
      // per-address send quota.
      tx.update(ref, { codeHash: '', expiresAt: Timestamp.fromMillis(0) });
      return true;
    });
    return consumed ? { ok: true, email } : wrong();
  } finally {
    active -= 1;
  }
}

export const OTP_LIMITS = {
  CODE_TTL_MS, RESEND_COOLDOWN_MS, MAX_ATTEMPTS, MAX_PER_EMAIL_HOUR, MAX_PER_EMAIL_DAY,
};
