/**
 * The machinery: sessions, rate-limit counters, audit events and order numbers.
 *
 * None of this is business data. It is the state the server needs to be a safe
 * server, and it moved to Firestore with everything else so there is exactly one
 * datastore to configure, back up and reason about — the alternative was keeping
 * a SQLite file alive purely for counters, which is the "two production
 * databases by accident" that §79 of the brief warns about.
 */

import { collections, orderCounterDoc, FieldValue, Timestamp } from '../firestore.js';
import { assertAuditEvent } from '../invariants.js';

const now = () => FieldValue.serverTimestamp();

// -------------------------------------------------------------- sessions ----

/**
 * Sessions are keyed by an HMAC of the token, never the token itself, so a read
 * of this collection — an export, a console, a leaked backup — is not a list of
 * working sign-in credentials.
 */
export async function putSession(tokenHash, kind, subject, expiresAtMs) {
  await collections.sessions().doc(tokenHash).set({
    kind,
    subject: String(subject),
    expiresAt: Timestamp.fromMillis(expiresAtMs),
    createdAt: now(),
  });
}

export async function readSessionRecord(tokenHash, kind) {
  const doc = await collections.sessions().doc(tokenHash).get();
  if (!doc.exists) return null;
  const session = doc.data();
  if (session.kind !== kind) return null;
  // Expiry is enforced on read, not by a sweeper. A sweeper that fails leaves
  // sessions valid forever; a read-time check cannot fail open.
  if (session.expiresAt.toMillis() <= Date.now()) return null;
  return { subject: session.subject, expiresAtMs: session.expiresAt.toMillis() };
}

export async function deleteSession(tokenHash) {
  await collections.sessions().doc(tokenHash).delete();
}

/**
 * Remove expired sessions.
 *
 * Firestore has no TTL in the emulator and TTL policies on a real project are
 * eventually-consistent, so this exists to keep the collection from growing
 * without bound. Correctness never depends on it — see the read-time check
 * above — which is why it is safe to call opportunistically and ignore failures.
 */
export async function purgeExpiredSessions(limit = 200) {
  const stale = await collections.sessions()
    .where('expiresAt', '<=', Timestamp.now()).limit(limit).get();
  if (stale.empty) return 0;
  const batch = collections.sessions().firestore.batch();
  for (const doc of stale.docs) batch.delete(doc.ref);
  await batch.commit();
  return stale.size;
}

// ----------------------------------------------------------- rate limits ----

/**
 * A durable rate-limit counter.
 *
 * Increment is a transaction so two requests arriving together cannot both read
 * the same count and both write count+1 — which is the exact race that turns a
 * limit of 10 into a limit of "10, usually".
 *
 * This is used only for the strict, low-volume classes: sign-in, checkout, promo
 * validation, one-time codes. See `backend/security.js` for why the high-volume
 * public read limiter deliberately does not use it.
 */
export async function incrementRateLimit(key, windowMs) {
  const ref = collections.rateLimits().doc(key);
  const db = collections.rateLimits().firestore;
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const nowMs = Date.now();
    const existing = doc.exists ? doc.data() : null;
    const expired = !existing || existing.resetAt.toMillis() <= nowMs;
    const hits = expired ? 1 : existing.hits + 1;
    const resetAt = expired ? nowMs + windowMs : existing.resetAt.toMillis();
    tx.set(ref, { hits, resetAt: Timestamp.fromMillis(resetAt) });
    return { totalHits: hits, resetTime: new Date(resetAt) };
  });
}

export async function decrementRateLimit(key) {
  const ref = collections.rateLimits().doc(key);
  const db = collections.rateLimits().firestore;
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    tx.update(ref, { hits: Math.max(0, doc.data().hits - 1) });
  });
}

export async function resetRateLimit(key) {
  await collections.rateLimits().doc(key).delete();
}

export async function purgeExpiredRateLimits(limit = 500) {
  const stale = await collections.rateLimits()
    .where('resetAt', '<=', Timestamp.now()).limit(limit).get();
  if (stale.empty) return 0;
  const batch = collections.rateLimits().firestore.batch();
  for (const doc of stale.docs) batch.delete(doc.ref);
  await batch.commit();
  return stale.size;
}

// ----------------------------------------------------------------- audit ----

/**
 * Append an audit event.
 *
 * `.create()` on a fresh auto-id document, always. Never set, never update,
 * never delete — there is no code path in `backend/` that does any of those, and
 * that discipline is what replaces the SQLite append-only triggers.
 */
export async function appendAuditEvent({ actor, action, resource, requestId = '' }) {
  assertAuditEvent({ actor, action, resource });
  await collections.auditEvents().doc().create({
    actor, action, resource, requestId, createdAt: now(),
  });
}

export async function recentAuditEvents(limit = 100) {
  const snapshot = await collections.auditEvents()
    .orderBy('createdAt', 'desc').limit(limit).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

// --------------------------------------------------------------- counters ----

/**
 * Allocate the next order reference, inside the caller's transaction.
 *
 * References are allocated from a counter rather than derived from a document
 * id, so they stay contiguous and readable over the phone. The counter document
 * must have been read by the caller first — Firestore requires all reads before
 * any write in a transaction — so this takes the snapshot rather than fetching.
 */
export function allocateReferenceInTransaction(tx, counterSnapshot) {
  const current = counterSnapshot.exists ? counterSnapshot.data().value : 1000;
  const next = current + 1;
  tx.set(orderCounterDoc(), { value: next });
  return { seq: next, reference: `HC-${next}` };
}

export { orderCounterDoc };

// ------------------------------------------------------------------- otp ----

export async function readOtpRecord(email) {
  const doc = await collections.otpCodes().doc(email).get();
  return doc.exists ? doc.data() : null;
}

export async function writeOtpRecord(email, record) {
  await collections.otpCodes().doc(email).set(record);
}

export async function updateOtpRecord(email, patch) {
  await collections.otpCodes().doc(email).update(patch);
}

export const otpCollection = () => collections.otpCodes();

// -------------------------------------------------------------- mail log ----

/**
 * One send, once.
 *
 * The dedupe key IS the document id, so the claim is `create()` — which fails
 * if the document exists — rather than a read followed by a write. Read-then-
 * write is not a lock: two requests can both read "nothing sent" before either
 * writes, and the customer gets the same receipt twice. Firestore's create is
 * atomic and needs no transaction, no query and therefore no index.
 *
 * A failed send releases its claim, so the next genuine attempt can still get
 * through. A claim left behind by a crash between claim and send costs one
 * unsent email, which is the safer of the two ways to be wrong.
 */
export async function claimMailSend(dedupeKey) {
  try {
    await collections.mailLog().doc(dedupeKey).create({ status: 'sending', createdAt: now() });
    return true;
  } catch (error) {
    // 6 is ALREADY_EXISTS. Anything else is a real datastore failure.
    if (error?.code === 6) return false;
    throw error;
  }
}

export async function recordMailSent(dedupeKey, { to, subject }) {
  await collections.mailLog().doc(dedupeKey).set({
    status: 'sent',
    to: String(to).slice(0, 320),
    subject: String(subject).slice(0, 200),
    sentAt: now(),
  }, { merge: true });
}

export async function releaseMailClaim(dedupeKey) {
  await collections.mailLog().doc(dedupeKey).delete();
}
