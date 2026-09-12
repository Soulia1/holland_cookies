/**
 * Customers and account profiles.
 *
 * Two different things that both describe a person, kept apart for the same
 * reason they were two tables:
 *
 *   A *customer* is created by placing an order. It is keyed on the normalised
 *   phone number, because that is the field this business actually uses to find
 *   someone and the one a returning customer types the same way twice. Nobody
 *   proves they own a phone number; it is a label on an order, not an identity.
 *
 *   A *profile* is an account. It is keyed on an email address that has been
 *   proved by a one-time code, and that proof is the only reason it is safe to
 *   attach past guest orders to it.
 *
 * Both use their natural key as the document id, which replaces two UNIQUE
 * constraints (`customers.phone`, `profiles.email`) with something Firestore can
 * actually enforce. SQLite's INTEGER AUTOINCREMENT ids are gone; nothing
 * depended on them being numbers.
 */

import { collections, FieldValue } from '../firestore.js';
import { money } from '../../shared/pricing.mjs';

const now = () => FieldValue.serverTimestamp();
const iso = (value) => (value?.toDate ? value.toDate().toISOString() : (value ?? null));

// ------------------------------------------------------------- customers ----

export const customerOut = (customer) => ({
  id: customer.phone,
  phone: customer.phone,
  firstName: customer.firstName ?? '',
  lastName: customer.lastName ?? '',
  email: customer.email ?? '',
  ordersCount: customer.ordersCount ?? 0,
  totalSpent: money(customer.totalSpent ?? 0),
  createdAt: iso(customer.createdAt),
});

const customerFromDoc = (doc) => ({ phone: doc.id, ...doc.data() });

export async function getCustomer(phone) {
  const doc = await collections.customers().doc(String(phone)).get();
  return doc.exists ? customerFromDoc(doc) : null;
}

export async function allCustomers() {
  const snapshot = await collections.customers().get();
  return snapshot.docs.map(customerFromDoc);
}

/**
 * The paginated directory, with substring search.
 *
 * Firestore cannot do `LIKE '%noha%'`. It has no substring operator at all —
 * only equality, ranges, and a prefix trick built out of `>=`/`<`, and a prefix
 * is precisely what this search is not: the useful queries are "noha", "1650",
 * the middle of a phone number.
 *
 * So the filter happens here, in memory, over the whole customer collection.
 * That is a deliberate, bounded decision rather than an oversight:
 *
 *   - It is what the SQLite version did too. `LIKE` with a leading wildcard
 *     cannot use an index either, so that query was already a full scan; the
 *     cost moved from SQLite's page cache to a Firestore read quota, and the
 *     algorithmic shape did not change.
 *   - A bakery's customer list is thousands of documents at the outside.
 *   - The alternative — mirroring names into a search service, or storing an
 *     n-gram index on every customer — is real infrastructure, and §33 of the
 *     launch brief is explicit that expensive always-on services are not to be
 *     added blindly.
 *
 * The honest limit is written down in docs/FIRESTORE_SCHEMA.md: when this
 * collection outgrows a single read, it needs a search index, and the place to
 * put one is here.
 */
export async function searchCustomers({ page = 1, perPage = 25, q = '' } = {}) {
  const all = await allCustomers();
  const needle = String(q ?? '').trim().toLowerCase();
  const matched = needle
    ? all.filter((customer) => [
      customer.firstName, customer.lastName, customer.phone, customer.email,
    ].some((field) => String(field ?? '').toLowerCase().includes(needle)))
    : all;

  matched.sort((a, b) => (b.totalSpent ?? 0) - (a.totalSpent ?? 0)
    || String(a.phone).localeCompare(String(b.phone)));

  const start = (page - 1) * perPage;
  return {
    customers: matched.slice(start, start + perPage).map(customerOut),
    page,
    perPage,
    total: matched.length,
    pages: Math.max(1, Math.ceil(matched.length / perPage)),
  };
}

/**
 * Record a customer against an order, inside the caller's transaction.
 *
 * Takes the transaction rather than opening its own, because the customer's
 * running totals and the order that produced them have to commit together — a
 * customer credited for an order that then failed to write is exactly the
 * inconsistency the order transaction exists to prevent.
 *
 * The caller must have already read `existing` inside the same transaction;
 * Firestore requires all reads before any write.
 */
export function upsertCustomerInTransaction(tx, { phone, firstName, lastName, email, orderTotal }, existing) {
  const ref = collections.customers().doc(phone);
  if (!existing) {
    tx.create(ref, {
      firstName: firstName ?? '',
      lastName: lastName ?? '',
      email: email ?? '',
      ordersCount: 1,
      totalSpent: money(orderTotal),
      createdAt: now(),
      updatedAt: now(),
    });
    return;
  }
  tx.update(ref, {
    firstName: firstName ?? existing.firstName ?? '',
    lastName: lastName ?? existing.lastName ?? '',
    // An empty email on this order must not erase one captured earlier.
    email: email || existing.email || '',
    ordersCount: (existing.ordersCount ?? 0) + 1,
    totalSpent: money((existing.totalSpent ?? 0) + orderTotal),
    updatedAt: now(),
  });
}

// -------------------------------------------------------------- profiles ----

export const profileOut = (profile) => ({
  id: profile.email,
  email: profile.email,
  fullName: profile.fullName ?? '',
  phone: profile.phone ?? '',
  defaultArea: profile.defaultArea ?? '',
  defaultAddress: profile.defaultAddress ?? '',
});

export async function getProfile(email) {
  const doc = await collections.profiles().doc(String(email).toLowerCase()).get();
  return doc.exists ? { email: doc.id, ...doc.data() } : null;
}

const PROFILE_WRITABLE = ['fullName', 'phone', 'defaultArea', 'defaultAddress'];

/**
 * Patch a profile.
 *
 * The email is not in the writable list and that is load-bearing: it is the
 * identity the account was proved with, and changing it would move the account
 * to an address nobody has demonstrated they control.
 */
export async function updateProfile(email, patch) {
  const update = Object.fromEntries(
    Object.entries(patch).filter(([key]) => PROFILE_WRITABLE.includes(key)),
  );
  if (!Object.keys(update).length) return;
  await collections.profiles().doc(String(email).toLowerCase())
    .set({ ...update, updatedAt: now() }, { merge: true });
}

export { iso };
