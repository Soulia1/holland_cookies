import { collections, FieldValue } from './firestore.js';
import { refresh } from './mirror.js';
import { createSession, readStoredSession, revokeSession, cookieOptions } from './sessionStore.js';
import { getProfile, profileOut } from './repo/people.js';

const SESSION_COOKIE = 'holland_customer_session';
const TTL = 30 * 24 * 60 * 60;

export async function issueCustomerSession(res, { profileId }) {
  const token = await createSession('customer', profileId, TTL);
  res.cookie(SESSION_COOKIE, token, cookieOptions(TTL));
  return token;
}

export async function clearCustomerSession(res, req) {
  await revokeSession(req?.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, cookieOptions(0));
}

export async function readCustomer(req) {
  const session = await readStoredSession(req.cookies?.[SESSION_COOKIE], 'customer');
  if (!session) return null;
  const profile = await getProfile(session.subject);
  return profile ? profileOut(profile) : null;
}

export async function requireCustomer(req, res, next) {
  try {
    const customer = await readCustomer(req);
    if (!customer) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Sign in to see this.' });
    }
    req.customer = customer;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Create or fetch the account for a proved email, and adopt its guest orders.
 *
 * Runs as a transaction so the profile and the orders it claims move together.
 *
 * The orders adopted are only those whose email matches AND which are not
 * already claimed. That second condition is what stops an order ever being
 * moved from one account to another: once `profileId` is set, no later sign-in
 * can reassign it.
 *
 * ### A Firestore-specific limit, stated plainly
 *
 * The claim query is capped. Firestore transactions cannot hold an unbounded
 * result set — there is a hard limit on documents touched — so a first sign-in
 * for an address with more than `CLAIM_LIMIT` guest orders adopts the most
 * recent batch and leaves the rest. Signing in again adopts the next batch. For
 * this business the cap will never be reached; it is here because silently
 * truncating would be worse than a documented, self-healing partial claim.
 */
const CLAIM_LIMIT = 200;

export async function claimProfile(email) {
  const address = String(email).toLowerCase();
  const profileRef = collections.profiles().doc(address);
  const db = collections.profiles().firestore;

  const claimed = [];
  const result = await db.runTransaction(async (tx) => {
    claimed.length = 0;
    const profileSnap = await tx.get(profileRef);

    const unclaimed = await tx.get(
      collections.orders()
        .where('email', '==', address)
        .where('profileId', '==', null)
        .orderBy('seq', 'desc')
        .limit(CLAIM_LIMIT),
    );

    // Backfill from the most recent order, so a first sign-in arrives with a
    // name and phone already filled in rather than blank.
    const existing = profileSnap.exists ? profileSnap.data() : {};
    const recent = unclaimed.docs[0]?.data();

    const profile = {
      fullName: existing.fullName
        || (recent ? `${recent.firstName ?? ''} ${recent.lastName ?? ''}`.trim() : ''),
      phone: existing.phone || recent?.phone || '',
      defaultArea: existing.defaultArea || recent?.area || '',
      defaultAddress: existing.defaultAddress || recent?.address || '',
      updatedAt: FieldValue.serverTimestamp(),
      ...(profileSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    };

    tx.set(profileRef, profile, { merge: true });
    for (const doc of unclaimed.docs) {
      tx.update(doc.ref, { profileId: address });
      claimed.push(doc.id);
    }

    return {
      profile: { email: address, ...existing, ...profile },
      linkedOrders: unclaimed.size,
    };
  });
  // The account page reads orders from the mirror.
  await refresh('orders', claimed);
  return result;
}

export { SESSION_COOKIE };
