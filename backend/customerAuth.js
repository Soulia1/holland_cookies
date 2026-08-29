/**
 * Customer sessions.
 *
 * Deliberately the same shape as `adminSession.js`: a short-lived JWT in an
 * httpOnly cookie, signed with a secret that already exists. No Firebase Auth,
 * no Identity Platform, no SMS — the whole identity layer costs nothing to run
 * and has no console setup to get wrong.
 *
 * The email in a session is only ever written after a one-time code sent to
 * that address came back correctly. That is what makes it safe to attach past
 * guest orders to the account: the claim is proved, not typed.
 */

import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import * as db from './db.js';

const SESSION_COOKIE = 'holland_customer_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days of inactivity
const SESSION_SUBJECT = 'customer';

// The window rolls forward on use, so a customer who keeps ordering is never
// signed out — the 30 days run from their last visit rather than from sign-in.
// Signing back in costs them an emailed code, so a fixed expiry would ask a
// monthly regular to re-prove an address they had already proved. Renewing at
// the halfway mark keeps Set-Cookie off ordinary browsing requests.
const RENEW_AFTER_SECONDS = SESSION_TTL_SECONDS / 2;

// Still bounded: a rolling session that never ended would let a stolen cookie
// live for ever. `lgn` carries the original sign-in time across renewals.
const SESSION_MAX_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/**
 * Namespaced away from the admin secret, so an admin-session forgery cannot be
 * replayed as a customer session or the reverse.
 */
function signingSecret() {
  const secret = process.env.JWT_SECRET || process.env.ADMIN_KEY;
  if (!secret) return null;
  return createHash('sha256').update(`customer-session:${secret}`, 'utf8').digest('hex');
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function secureCookie() {
  return process.env.HTTPS_ORIGIN !== undefined
    ? process.env.HTTPS_ORIGIN === 'true'
    : process.env.NODE_ENV === 'production';
}

function setCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

export function issueCustomerSession(res, { profileId, email }) {
  const secret = signingSecret();
  if (!secret || !profileId || !email) return null;
  const token = jwt.sign(
    { sub: SESSION_SUBJECT, uid: String(profileId), email, lgn: nowSeconds() },
    secret,
    { expiresIn: SESSION_TTL_SECONDS },
  );
  setCookie(res, token);
  return token;
}

export function clearCustomerSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * The signed-in customer, or null.
 *
 * Returns `{ id, email, ... }` read from the *database* rather than from the
 * token: the token proves who they are, but a profile they have since edited
 * must not be served from a month-old claim.
 */
export function readCustomer(req, res) {
  const secret = signingSecret();
  const token = req.cookies?.[SESSION_COOKIE];
  if (!secret || !token) return null;

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return null; // expired, tampered, or signed with a rotated secret
  }
  if (payload.sub !== SESSION_SUBJECT || !payload.uid || !payload.email) return null;

  const loginAt = typeof payload.lgn === 'number' ? payload.lgn : payload.iat;
  if (typeof loginAt === 'number' && nowSeconds() - loginAt > SESSION_MAX_LIFETIME_SECONDS) {
    return null; // past the absolute ceiling — sign in again
  }

  const profile = db.get()
    .prepare('SELECT * FROM profiles WHERE id = ?')
    .get(Number(payload.uid));
  // The profile was deleted out from under a live session.
  if (!profile || profile.email !== payload.email) return null;

  if (res && typeof payload.iat === 'number' && nowSeconds() - payload.iat > RENEW_AFTER_SECONDS) {
    const renewed = jwt.sign(
      { sub: SESSION_SUBJECT, uid: payload.uid, email: payload.email, lgn: loginAt ?? nowSeconds() },
      secret,
      { expiresIn: SESSION_TTL_SECONDS },
    );
    setCookie(res, renewed);
  }

  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.full_name,
    phone: profile.phone,
    defaultArea: profile.default_area,
    defaultAddress: profile.default_address,
  };
}

/** Express middleware: 401 unless a customer is signed in. */
export function requireCustomer(req, res, next) {
  const customer = readCustomer(req, res);
  if (!customer) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Sign in to see this.' });
  }
  req.customer = customer;
  return next();
}

/**
 * Find or create the profile for a proved email, and attach every past order
 * placed with it.
 *
 * The attach is the point of having accounts at all: somebody who ordered three
 * times as a guest and then signs in should see those three orders, not an
 * empty history. It is only safe because the email was proved by a code — see
 * the note at the top of this file.
 */
export function claimProfile(email) {
  const database = db.get();
  return database.transaction(() => {
    database.prepare(`
      INSERT INTO profiles (email) VALUES (?)
      ON CONFLICT(email) DO UPDATE SET updated_at = datetime('now')
    `).run(email);
    const profile = database.prepare('SELECT * FROM profiles WHERE email = ?').get(email);

    // Only orders that are not already claimed, so re-signing in is cheap and
    // an order can never be moved from one account to another.
    const linked = database.prepare(`
      UPDATE orders SET profile_id = ?
      WHERE LOWER(email) = ? AND profile_id IS NULL
    `).run(profile.id, email);

    // Backfill the profile from the most recent order, so a first sign-in
    // arrives with a name and phone already filled in rather than blank.
    const recent = database.prepare(`
      SELECT first_name, last_name, phone, area, address FROM orders
      WHERE profile_id = ? ORDER BY id DESC LIMIT 1
    `).get(profile.id);
    if (recent) {
      database.prepare(`
        UPDATE profiles SET
          full_name = CASE WHEN full_name = '' THEN @name ELSE full_name END,
          phone = CASE WHEN phone = '' THEN @phone ELSE phone END,
          default_area = CASE WHEN default_area = '' THEN @area ELSE default_area END,
          default_address = CASE WHEN default_address = '' THEN @address ELSE default_address END,
          updated_at = datetime('now')
        WHERE id = @id
      `).run({
        id: profile.id,
        name: `${recent.first_name} ${recent.last_name}`.trim(),
        phone: recent.phone ?? '',
        area: recent.area ?? '',
        address: recent.address ?? '',
      });
    }

    return {
      profile: database.prepare('SELECT * FROM profiles WHERE id = ?').get(profile.id),
      linkedOrders: linked.changes,
    };
  })();
}

export { SESSION_COOKIE };
