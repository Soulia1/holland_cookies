/**
 * Admin sessions.
 *
 * The dashboard never stores the master key. It posts the key once and gets
 * back a short-lived signed session in an httpOnly cookie — unreadable from
 * JavaScript, so an XSS bug in the dashboard cannot exfiltrate the credential
 * that controls the whole shop, and it expires on its own. The master key stays
 * usable as a direct header for scripts and server-to-server calls.
 *
 * Adapted from Scooby's `adminSession.js`, including the rolling-expiry
 * reasoning: a bakery runs on one shared key that somebody has to go and look
 * up, so a session that expired a fixed interval after sign-in logged the admin
 * out mid-shift however busy they had been.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

const SESSION_COOKIE = 'holland_admin_session';
const SESSION_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days of inactivity
const SESSION_SUBJECT = 'admin';

// Renewed at the halfway mark rather than on every request, so the three days
// run from the last request instead of from sign-in — without putting a
// Set-Cookie on the polling endpoints the orders screen hits every few seconds.
const RENEW_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;

// A rolling session that never ended would let a stolen cookie live for ever,
// so there is still a hard ceiling. `lgn` carries the original sign-in time
// across renewals to enforce it.
const SESSION_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;

/**
 * Temporary local-development escape hatch.
 *
 * Production deliberately ignores this flag so a copied development .env
 * cannot accidentally publish the dashboard without authentication.
 */
export function isAdminAuthDisabled() {
  return process.env.NODE_ENV !== 'production'
    && process.env.DISABLE_ADMIN_AUTH === 'true';
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

/**
 * Constant-time comparison.
 *
 * Hashed first so both sides are always 32 bytes: `timingSafeEqual` throws on a
 * length mismatch, and an exception that only happens for wrong-length input is
 * itself a length oracle.
 */
export function matchesMasterKey(supplied) {
  const configured = process.env.ADMIN_KEY;
  if (!configured || typeof supplied !== 'string' || !supplied) return false;
  return timingSafeEqual(digest(supplied), digest(configured));
}

/**
 * Sessions are signed with JWT_SECRET when there is one, otherwise with a value
 * derived from ADMIN_KEY — so rotating either secret invalidates every session
 * that was issued under the old one.
 */
function signingSecret() {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_KEY;
  if (!secret) throw new Error('ADMIN_KEY or JWT_SECRET must be set');
  return createHash('sha256').update(`holland:${secret}`, 'utf8').digest('hex');
}

export function issueSession(res) {
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    { sub: SESSION_SUBJECT, lgn: now },
    signingSecret(),
    { expiresIn: SESSION_TTL_SECONDS },
  );
  setCookie(res, token);
  return token;
}

function setCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Keyed on whether the origin is actually HTTPS, not on NODE_ENV — see the
    // note on `httpsOrigin` in server.js. A cookie marked Secure is never sent
    // back over plain HTTP, which makes sign-in appear to succeed and every
    // request after it appear anonymous.
    secure: process.env.HTTPS_ORIGIN !== undefined
      ? process.env.HTTPS_ORIGIN === 'true'
      : process.env.NODE_ENV === 'production',
    // `lax` and not `none`: the dashboard is served from the same origin as the
    // API, so there is no cross-site case to support, and `none` would opt into
    // exactly the CSRF exposure this avoids.
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Is this request authenticated, and should its session be renewed?
 *
 * Returns `null` for anonymous rather than throwing, so the caller decides what
 * an unauthenticated request means — a 401 on the API, a redirect on a page.
 */
export function readSession(req, res) {
  if (isAdminAuthDisabled()) {
    return { subject: SESSION_SUBJECT, viaKey: false, authDisabled: true };
  }

  // The master key as a header: for scripts, and for the sign-in request that
  // has no cookie yet.
  const headerKey = req.get('x-admin-key');
  if (headerKey && matchesMasterKey(headerKey)) return { subject: SESSION_SUBJECT, viaKey: true };

  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  let claims;
  try {
    claims = jwt.verify(token, signingSecret());
  } catch {
    return null;
  }
  if (claims.sub !== SESSION_SUBJECT) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.lgn === 'number' && now - claims.lgn > SESSION_MAX_LIFETIME_SECONDS) {
    return null;
  }

  // Roll it forward if it is past the halfway mark, preserving the original
  // sign-in time so the hard ceiling still applies.
  if (res && typeof claims.iat === 'number' && now - claims.iat > RENEW_AFTER_SECONDS) {
    const renewed = jwt.sign(
      { sub: SESSION_SUBJECT, lgn: claims.lgn ?? now },
      signingSecret(),
      { expiresIn: SESSION_TTL_SECONDS },
    );
    setCookie(res, renewed);
  }

  return { subject: SESSION_SUBJECT, viaKey: false };
}

/**
 * A local-development bypass.
 *
 * `DISABLE_ADMIN_AUTH=true` opens the dashboard without a key. Deliberately
 * ignored whenever NODE_ENV is production, so setting it on a deployed server
 * does nothing — a flag that can accidentally unlock a live shop is not a
 * convenience, it is a vulnerability with a friendly name.
 *
 * It is also the reason the sign-in gate can be reached at all right now: with
 * `ADMIN_KEY` unset, `matchesMasterKey` refuses every key, so without this the
 * dashboard would simply be unreachable.
 */
export function adminAuthDisabled() {
  return process.env.NODE_ENV !== 'production'
    && process.env.DISABLE_ADMIN_AUTH === 'true';
}

/** Express middleware: 401 unless the request carries a valid admin session. */
export function requireAdmin(req, res, next) {
  if (adminAuthDisabled()) {
    req.admin = { subject: SESSION_SUBJECT, viaKey: false, bypassed: true };
    return next();
  }
  const session = readSession(req, res);
  if (!session) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin sign-in required.' });
  }
  req.admin = session;
  return next();
}

export { SESSION_COOKIE };
