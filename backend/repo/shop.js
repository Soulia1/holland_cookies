/**
 * Discount codes and shop settings.
 *
 * Promos are keyed by the uppercased code, so `welcome10` and `WELCOME10` are
 * the same document and case normalisation is enforced by the storage layer
 * rather than remembered at each call site. That was a UNIQUE constraint on a
 * `code` column before; it is a document id now, which is the same guarantee
 * bought more cheaply.
 *
 * Settings are one document, `settings/shop`, mirroring the single-row
 * `settings` table with its `CHECK (id = 1)`.
 */

import { collections, settingsDoc, FieldValue } from '../firestore.js';
import { live, refresh } from '../mirror.js';

const now = () => FieldValue.serverTimestamp();
const iso = (value) => (value?.toDate ? value.toDate().toISOString() : (value ?? null));

// ---------------------------------------------------------------- promos ----

export const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

/**
 * Whether a normalised code can name a promo document at all.
 *
 * Firestore reads a "/" as a path and reserves ids shaped like `__name__`, and
 * either one threw inside the SDK: a customer typing `a/b` into the promo box
 * got a server error for what is only a code that does not exist.
 */
export const isPromoCode = (code) => /^(?!__.*__$)[A-Z0-9_-]{1,40}$/.test(String(code));

export const promoOut = (promo) => ({
  code: promo.code,
  type: promo.type,
  value: promo.value,
  minSubtotal: promo.minSubtotal ?? 0,
  maxUses: promo.maxUses ?? 0,
  usedCount: promo.usedCount ?? 0,
  active: !!promo.active,
  expiresAt: promo.expiresAt ?? null,
});

const promoFromDoc = (doc) => ({ code: doc.id, ...doc.data() });

export async function listPromos() {
  const mirror = live('promos');
  const rows = mirror
    ? mirror.docs().map(([code, data]) => ({ code, ...data }))
    : (await collections.promos().get()).docs.map(promoFromDoc);
  return rows
    .sort((a, b) => String(iso(b.createdAt) ?? '').localeCompare(String(iso(a.createdAt) ?? '')));
}

export async function getPromo(code) {
  const id = normalizeCode(code);
  if (!isPromoCode(id)) return null;
  const mirror = live('promos');
  if (mirror) {
    const data = mirror.get(id);
    return data ? { code: id, ...data } : null;
  }
  const doc = await collections.promos().doc(id).get();
  return doc.exists ? promoFromDoc(doc) : null;
}

export async function createPromo(body) {
  const code = normalizeCode(body.code);
  const document = {
    type: body.type,
    value: body.value,
    minSubtotal: body.minSubtotal ?? 0,
    maxUses: body.maxUses ?? 0,
    usedCount: 0,
    active: body.active !== false,
    // Stored as the ISO string the API speaks, so a comparison against
    // `new Date()` behaves identically to the SQLite TEXT column it replaces.
    expiresAt: body.expiresAt ?? null,
    createdAt: now(),
  };
  try {
    await collections.promos().doc(code).create(document);
  } catch (error) {
    if (error.code === 6) return { duplicate: true };
    throw error;
  }
  await refresh('promos', code);
  return { duplicate: false, promo: promoOut({ code, ...document }) };
}

/**
 * Patch a promo.
 *
 * `usedCount` is deliberately absent from the writable list. It is a redemption
 * ledger, incremented only inside the order transaction, and an admin endpoint
 * that could set it would be an admin endpoint that could hand out an expired
 * code's remaining uses again.
 */
const PROMO_WRITABLE = ['type', 'value', 'minSubtotal', 'maxUses', 'active', 'expiresAt'];

export async function updatePromo(code, patch) {
  if (!isPromoCode(normalizeCode(code))) return { found: false, changed: false };
  const update = Object.fromEntries(
    Object.entries(patch).filter(([key]) => PROMO_WRITABLE.includes(key)),
  );
  if (!Object.keys(update).length) return { found: true, changed: false };
  try {
    await collections.promos().doc(normalizeCode(code)).update(update);
  } catch (error) {
    if (error.code === 5) return { found: false, changed: false };
    throw error;
  }
  await refresh('promos', normalizeCode(code));
  return { found: true, changed: true };
}

export async function deletePromo(code) {
  if (!isPromoCode(normalizeCode(code))) return false;
  const ref = collections.promos().doc(normalizeCode(code));
  if (!(await ref.get()).exists) return false;
  await ref.delete();
  await refresh('promos', ref.id);
  return true;
}

// -------------------------------------------------------------- settings ----

/** The defaults a shop starts with, and what a missing document reads as. */
export const DEFAULT_SETTINGS = {
  deliveryFee: 0,
  freeDeliveryOver: 0,
  acceptingOrders: true,
  areas: [],
};

export async function getSettings() {
  const mirror = live('settings');
  if (mirror) {
    const data = mirror.get(settingsDoc().id);
    return data ? { ...DEFAULT_SETTINGS, ...data } : { ...DEFAULT_SETTINGS };
  }
  const doc = await settingsDoc().get();
  // A missing settings document must not take the shop down. It reads as the
  // defaults, which are "open, free delivery, no area restriction" — the same
  // values `INSERT OR IGNORE INTO settings (id) VALUES (1)` produced.
  return doc.exists ? { ...DEFAULT_SETTINGS, ...doc.data() } : { ...DEFAULT_SETTINGS };
}

const SETTINGS_WRITABLE = ['deliveryFee', 'freeDeliveryOver', 'acceptingOrders', 'areas'];

export async function updateSettings(patch) {
  const update = Object.fromEntries(
    Object.entries(patch).filter(([key]) => SETTINGS_WRITABLE.includes(key)),
  );
  if (!Object.keys(update).length) return;
  // merge:true so a patch of one field does not blank the others, and so the
  // document is created if it has never been written.
  await settingsDoc().set({ ...update, updatedAt: now() }, { merge: true });
  await refresh('settings', settingsDoc().id);
}

export { iso };
