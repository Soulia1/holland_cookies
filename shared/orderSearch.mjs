// How an order is matched against what an operator typed.
//
// This lives in shared/ next to orderStatus.mjs for the same reason: matching
// has to be defined once. The API filters with it and the dashboard highlights
// with it, and a search that finds a row the UI then fails to mark up is a bug
// that only shows on somebody else's screen.
//
// Firestore cannot answer "contains, case-insensitively, across ten fields" —
// it has no substring operator and no case-insensitive comparison — so the
// matching is done in process over documents the API has already read. Nothing
// here touches the database or mutates an order: every value is normalised into
// a throwaway index, and the stored record is left exactly as the customer
// wrote it.

/** Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Tashkeel, Quranic annotation marks and the tatweel (ـ) — all decoration over
 * the letters, none of it typed into a search box. Stripping them is the one
 * safe Arabic fold: it can only widen what a query matches, never redirect it
 * onto a different word.
 */
const ARABIC_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

/** أ إ آ ٱ all stand for ا, and few people type the hamza in a name. */
const ALEF_VARIANTS = /[آأإٱ]/g;

/** A number typed on an Arabic keyboard has to find the same order. */
function foldDigits(value) {
  return value.replace(ARABIC_INDIC_DIGITS, (char) => {
    const code = char.codePointAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/**
 * The form both stored values and the query are compared in.
 *
 * NFKC first, so a name stored in Arabic presentation forms or full-width Latin
 * compares equal to the same name typed normally. Lowercasing is deliberately
 * locale-independent — toLocaleLowerCase would fold `I` to `ı` under a Turkish
 * locale and stop `Ibrahim` matching itself.
 */
export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return foldDigits(String(value))
    .normalize('NFKC')
    .toLowerCase()
    .replace(ARABIC_MARKS, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(/ى/g, 'ي') // ى → ي
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every digit in a value, Arabic-Indic included, with the formatting dropped. */
export function digitsOf(value) {
  if (value === null || value === undefined) return '';
  return foldDigits(String(value)).replace(/\D+/g, '');
}

/**
 * The digit strings a stored phone number should be findable by.
 *
 * Numbers are stored normalised as +20…, but nobody searches for their own
 * customers that way — they search for the 010… they read off a delivery note,
 * or paste back the +20 the storefront produced. Both, and the bare national
 * number, are indexed so a prefix of any of them hits.
 */
export function phoneDigitVariants(phone) {
  const digits = digitsOf(phone);
  if (!digits) return [];
  const variants = new Set([digits]);
  let local = digits;
  if (local.startsWith('0020')) local = local.slice(4);
  else if (local.startsWith('20')) local = local.slice(2);
  if (local.startsWith('0')) local = local.slice(1);
  if (local) {
    variants.add(local);
    variants.add(`0${local}`);
    variants.add(`20${local}`);
  }
  return [...variants];
}

/** Product names, including what a bundle was filled with or defined as. */
function itemNames(items) {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => [
    item?.name,
    item?.choice?.name,
    ...(Array.isArray(item?.selections) ? item.selections.map((one) => one?.name) : []),
    ...(Array.isArray(item?.components) ? item.components.map((one) => one?.name) : []),
  ]);
}

/**
 * The normalised, throwaway view of one order that matching reads.
 *
 * Built once per order per snapshot rather than once per keystroke: the whole
 * point of an index is that typing another letter re-scores, it does not
 * re-normalise. `text` joins the remaining fields with a newline so a query
 * cannot match by running off the end of one field into the start of the next —
 * queries have their whitespace collapsed to single spaces, so no query can
 * ever contain one.
 */
export function buildOrderSearchIndex(order = {}) {
  const rest = [
    order.email,
    order.address,
    order.area,
    order.paymentMethod,
    order.paymentStatus,
    order.status,
    order.fulfillmentType,
    order.promoCode,
    ...itemNames(order.items),
  ];
  return {
    orderId: normalizeText(order.orderId),
    name: normalizeText(order.name),
    phone: normalizeText(order.phone),
    phoneDigits: phoneDigitVariants(order.phone),
    text: rest.map(normalizeText).filter(Boolean).join('\n'),
    createdAt: Date.parse(order.createdAt) || 0,
  };
}

/**
 * The query, normalised once for a whole pass over the orders.
 *
 * `digits` is separate from `text` because a phone is matched on its digits
 * alone — "010 1234 5678", "010-1234-5678" and "+20 101 234 5678" are the same
 * number and have to behave like it.
 */
export function parseSearchQuery(query) {
  const text = normalizeText(query);
  return { text, digits: digitsOf(query), empty: text.length === 0 };
}

// Ranking, strongest first. The set is small and the tiers are coarse on
// purpose: an operator wants the order they are looking for at the top, not a
// relevance model.
const SCORE = {
  orderIdExact: 100,
  orderIdPrefix: 90,
  nameExact: 80,
  namePrefix: 70,
  phonePrefix: 60,
  orderIdPartial: 50,
  namePartial: 40,
  phonePartial: 30,
  otherPartial: 10,
};

/**
 * How strongly one indexed order matches a parsed query. 0 means no match.
 *
 * An empty query matches everything with an equal score, so callers can run the
 * same path whether or not anything was typed.
 */
export function scoreSearchMatch(index, parsed) {
  if (parsed.empty) return 1;
  const { text, digits } = parsed;

  if (index.orderId) {
    if (index.orderId === text) return SCORE.orderIdExact;
    if (index.orderId.startsWith(text)) return SCORE.orderIdPrefix;
  }
  if (index.name) {
    if (index.name === text) return SCORE.nameExact;
    if (index.name.startsWith(text)) return SCORE.namePrefix;
  }
  if (digits && index.phoneDigits.some((variant) => variant.startsWith(digits))) {
    return SCORE.phonePrefix;
  }
  if (index.orderId && index.orderId.includes(text)) return SCORE.orderIdPartial;
  if (index.name && index.name.includes(text)) return SCORE.namePartial;
  if (digits && index.phoneDigits.some((variant) => variant.includes(digits))) {
    return SCORE.phonePartial;
  }
  if (index.phone && index.phone.includes(text)) return SCORE.phonePartial;
  if (index.text.includes(text)) return SCORE.otherPartial;
  return 0;
}

/**
 * Orders matching `query`, strongest match first and newest first within a tier.
 *
 * `indexOf` lets a caller that keeps its own indexes reuse them; without one an
 * index is built per order per call, which is fine for a one-off pass but not
 * for anything on a keystroke path.
 */
export function searchOrders(orders, query, indexOf = buildOrderSearchIndex) {
  const parsed = parseSearchQuery(query);
  if (parsed.empty) return [...orders];
  return orders
    .map((order) => ({ order, index: indexOf(order) }))
    .map((row) => ({ ...row, score: scoreSearchMatch(row.index, parsed) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.index.createdAt - a.index.createdAt)
    .map((row) => row.order);
}
