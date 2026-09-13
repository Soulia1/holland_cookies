/**
 * Creating an order.
 *
 * This is the file that makes the price in the browser not matter.
 *
 * Everything the client sends about money is ignored. The cart arrives as a
 * list of `{ productId, qty }`; the products are read from the catalogue inside
 * the transaction; the line prices, the subtotal, the discount, the delivery
 * and the total are all computed here from those documents, using the same
 * `shared/pricing.mjs` the storefront displays with. A cart edited in DevTools
 * to say a gateau costs four pounds produces an order for four hundred and
 * fifty, because the four was never read.
 *
 * `expectedTotal` is the one number the client sends that is looked at, and it
 * is used only to *refuse*: if the customer was shown a total that no longer
 * matches the catalogue — an admin repriced something while they were filling
 * in their address — the order is rejected rather than silently charging a
 * price they never agreed to. The authoritative figure comes back with the
 * error so the checkout can show them what changed.
 *
 * All of it runs inside one Firestore transaction, so an order is never half
 * written: either the order, its lines, its first status entry, the customer
 * record, the promo usage and the reference counter all commit, or none do.
 *
 * ## What the migration from SQLite changed here
 *
 * The shape of the guarantee is identical; the shape of the *code* is not,
 * because Firestore transactions require every read to happen before the first
 * write. SQLite let this file interleave them freely — read a product, write a
 * line, read the next. Here all six reads (idempotency, products, settings,
 * promo, counter, customer) are gathered at the top in one pass, and nothing is
 * written until every decision has been made.
 *
 * The second change is that Firestore retries a transaction whose reads were
 * invalidated by a concurrent write. That is what makes the promo redemption
 * counter safe under simultaneous checkouts: two orders racing for the last use
 * of a code do not both see `usedCount = 4`, because the loser's transaction is
 * replayed against the winner's committed value and then correctly refuses.
 * This function must therefore stay free of side effects outside the
 * transaction — it can and will run more than once.
 */

import { createHash } from 'node:crypto';
import {
  collections, orderCounterDoc, settingsDoc, FieldValue, Timestamp, get as firestore,
} from './firestore.js';
import {
  lineSignature, money, priceOrder, selectionProblem, unitPrice,
} from '../shared/pricing.mjs';
import { assertNewOrder } from './invariants.js';
import { upsertCustomerInTransaction } from './repo/people.js';
import { allocateReferenceInTransaction } from './repo/system.js';

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function fail(status, code, message, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  if (details) error.details = details;
  return error;
}

/**
 * Egyptian mobile numbers, in the shapes people actually type them.
 *
 * Normalised to `01XXXXXXXXX` so the same person is the same customer whether
 * they typed +20, 0020 or a leading zero. Used as the customer document id, so
 * getting this wrong means one person becoming three records.
 */
export function normalizePhone(input) {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  let local = digits;
  if (local.startsWith('+20')) local = `0${local.slice(3)}`;
  else if (local.startsWith('0020')) local = `0${local.slice(4)}`;
  else if (local.startsWith('20') && local.length === 12) local = `0${local.slice(2)}`;
  if (!local.startsWith('0')) local = `0${local}`;
  return /^01[0-25]\d{8}$/.test(local) ? local : null;
}

/**
 * Evaluate a promo code against a subtotal.
 *
 * Returns the discount in pounds, or a reason it does not apply. Read inside
 * the transaction so a code with one use left cannot be spent twice by two
 * checkouts landing together.
 */
export function evaluatePromo(promo, subtotal) {
  if (!promo) return { valid: false, reason: 'That code is not recognised.' };
  if (!promo.active) return { valid: false, reason: 'That code is no longer active.' };
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
    return { valid: false, reason: 'That code has expired.' };
  }
  if ((promo.maxUses ?? 0) > 0 && (promo.usedCount ?? 0) >= promo.maxUses) {
    return { valid: false, reason: 'That code has been fully redeemed.' };
  }
  if (subtotal < (promo.minSubtotal ?? 0)) {
    return {
      valid: false,
      reason: `That code needs a subtotal of at least ${promo.minSubtotal} EGP.`,
    };
  }
  const discount = promo.type === 'fixed'
    ? Math.min(promo.value, subtotal)
    : money(subtotal * (promo.value / 100));
  return { valid: true, discount: money(discount) };
}

/**
 * Create an order.
 *
 * @param {object} payload Validated by the route's zod schema before it gets
 *   here — this function assumes the shape is right and concerns itself only
 *   with whether the *contents* are still true against the catalogue.
 */
export async function createOrder(payload) {
  const phone = normalizePhone(payload.phone);
  if (!phone) throw fail(400, 'INVALID_PHONE', 'That phone number does not look right.');

  if (payload.paymentMethod && payload.paymentMethod !== 'cash') {
    throw fail(400, 'PAYMENT_UNAVAILABLE', 'Only cash orders are currently supported.');
  }
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 60
    || payload.items.some((i) => !Number.isInteger(i.qty) || i.qty < 1 || i.qty > 50)
    || new Set(payload.items.map((i) => lineSignature(i))).size !== payload.items.length
    || payload.items.reduce((sum, i) => sum + i.qty, 0) > 100) {
    throw fail(400, 'INVALID_ITEMS', 'Invalid cart quantities.');
  }

  const requestHash = hash(JSON.stringify({
    ...Object.fromEntries(['firstName', 'lastName', 'email', 'fulfilment', 'area', 'address',
      'building', 'floor', 'apartment', 'landmark', 'notes', 'promoCode', 'lang', 'expectedTotal']
      .map((k) => [k, payload[k] ?? ''])),
    items: payload.items.map(({ productId, qty, selections }) => ({
      productId, qty, ...(selections?.length ? { selections } : {}),
    })),
    phone,
    paymentMethod: payload.paymentMethod || 'cash',
  }));

  const ids = [...new Set(payload.items.map((item) => item.productId))];
  // The products a bundle line picked, read in the same pass so their names
  // and availability are as current as the bundle's own.
  const pickedIds = [...new Set(payload.items.flatMap(
    (item) => (item.selections ?? []).map((pick) => pick.productId),
  ))];
  const optionIds = pickedIds.filter((id) => !ids.includes(id));
  const idempotencyRef = collections.orderIdempotency().doc(payload.idempotencyKey);
  const promoRef = payload.promoCode
    ? collections.promos().doc(payload.promoCode.trim().toUpperCase())
    : null;
  const customerRef = collections.customers().doc(phone);

  return firestore().runTransaction(async (tx) => {
    // ================= EVERY READ, BEFORE ANY WRITE =========================

    const [idempotencySnap, settingsSnap, counterSnap, customerSnap] = await tx.getAll(
      idempotencyRef, settingsDoc(), orderCounterDoc(), customerRef,
    );
    const productSnaps = await tx.getAll(
      ...[...ids, ...optionIds].map((id) => collections.products().doc(id)),
    );
    const promoSnap = promoRef ? await tx.get(promoRef) : null;

    // --- Idempotency ------------------------------------------------------
    // A retried request returns the original order instead of making a second
    // one. The hash is compared so the same key cannot be reused for a
    // different basket, which would otherwise let a client overwrite the
    // meaning of an order that already exists.
    if (idempotencySnap.exists) {
      const seen = idempotencySnap.data();
      if (seen.requestHash !== requestHash) {
        throw fail(409, 'IDEMPOTENCY_CONFLICT',
          'This checkout key was already used for a different order.');
      }
      const existing = await tx.get(collections.orders().doc(seen.orderRef));
      return {
        order: { reference: existing.id, ...existing.data() },
        duplicate: true,
      };
    }

    // --- The catalogue, as it is right now ---------------------------------
    const catalogue = new Map();
    for (const snap of productSnaps) {
      if (snap.exists) catalogue.set(snap.id, { id: snap.id, ...snap.data() });
    }

    // A fixed bundle's contents, so the order line can name them for the kitchen.
    const componentIds = [...new Set(ids
      .map((id) => catalogue.get(id))
      .filter((product) => product?.isBundle && product.bundleType !== 'choice')
      .flatMap((product) => (product.components ?? []).map((component) => component.productId)))]
      .filter((id) => !catalogue.has(id));
    if (componentIds.length) {
      const componentSnaps = await tx.getAll(
        ...componentIds.map((id) => collections.products().doc(id)),
      );
      for (const snap of componentSnaps) {
        if (snap.exists) catalogue.set(snap.id, { id: snap.id, ...snap.data() });
      }
    }

    const missing = ids.filter((id) => !catalogue.has(id));
    if (missing.length) {
      throw fail(400, 'PRODUCT_MISSING',
        'Something in your cart is no longer on the menu.', { productIds: missing });
    }

    // A product in a hidden category is not on the menu. SQLite expressed this
    // as a JOIN against `categories.visible`; here the categories the cart
    // touches are read explicitly, because a Firestore query cannot join and
    // enforcing this only in the storefront would leave the API able to sell a
    // product the shop has taken down.
    const categoryIds = [...new Set([...catalogue.values()].map((p) => p.categoryId))];
    const categorySnaps = await tx.getAll(
      ...categoryIds.map((id) => collections.categories().doc(id)),
    );
    const hiddenCategories = new Set(
      categorySnaps.filter((snap) => !snap.exists || snap.data().visible === false)
        .map((snap) => snap.id),
    );
    const offMenu = ids.filter((id) => hiddenCategories.has(catalogue.get(id).categoryId));
    if (offMenu.length) {
      throw fail(400, 'PRODUCT_MISSING',
        'Something in your cart is no longer on the menu.', { productIds: offMenu });
    }

    const unavailable = ids.filter((id) => catalogue.get(id).available === false);
    if (unavailable.length) {
      throw fail(409, 'PRODUCT_UNAVAILABLE',
        'Something in your cart has sold out.', { productIds: unavailable });
    }

    // --- Bundles: the choices must still fit the bundle as it is now ---------
    for (const item of payload.items) {
      const problem = selectionProblem(catalogue.get(item.productId), item.selections);
      if (problem) {
        throw fail(400, 'INVALID_SELECTION', problem, { productId: item.productId });
      }
    }
    const pickedUnavailable = pickedIds.filter(
      (id) => !catalogue.has(id) || catalogue.get(id).available === false,
    );
    if (pickedUnavailable.length) {
      throw fail(409, 'PRODUCT_UNAVAILABLE',
        'One of your choices has sold out.', { productIds: pickedUnavailable });
    }

    // --- Settings, and whether the shop is even open ------------------------
    const shop = settingsSnap.exists ? settingsSnap.data() : {};
    if (shop.acceptingOrders === false) {
      throw fail(409, 'CLOSED', 'We are not taking orders at the moment.');
    }
    const areas = Array.isArray(shop.areas) ? shop.areas : [];
    if (payload.fulfilment === 'delivery' && areas.length
      && !areas.some((area) => area.id === payload.area)) {
      throw fail(400, 'INVALID_AREA', 'Choose a supported delivery area.');
    }
    const settings = {
      deliveryFee: shop.deliveryFee ?? 0,
      freeDeliveryOver: shop.freeDeliveryOver ?? 0,
    };

    // --- Price it -----------------------------------------------------------
    const priced = priceOrder({
      items: payload.items, catalogue, settings,
      fulfilment: payload.fulfilment, promoDiscount: 0,
    });

    let discount = 0;
    let promoCode = '';
    let promo = null;
    if (promoRef) {
      promo = promoSnap.exists ? { code: promoSnap.id, ...promoSnap.data() } : null;
      const result = evaluatePromo(promo, priced.subtotal);
      if (!result.valid) throw fail(400, 'INVALID_PROMO', result.reason);
      discount = result.discount;
      promoCode = promo.code;
    }

    const totals = priceOrder({
      items: payload.items, catalogue, settings,
      fulfilment: payload.fulfilment, promoDiscount: discount,
    });

    // --- The only number from the client that is read ----------------------
    // Compared, never used. A mismatch means the customer is looking at a
    // stale price, and charging them a different one — higher OR lower — is
    // not ours to do silently.
    if (typeof payload.expectedTotal === 'number'
      && money(payload.expectedTotal) !== totals.total) {
      throw fail(409, 'PRICE_CHANGED',
        'Prices changed while you were checking out. Please review your order.',
        { expectedTotal: money(payload.expectedTotal), currentTotal: totals.total });
    }

    // ======================== WRITES ========================================

    const { seq, reference } = allocateReferenceInTransaction(tx, counterSnap);

    const items = payload.items.map((item) => {
      const product = catalogue.get(item.productId);
      const unit = unitPrice(product, item.selections);
      const line = {
        productId: product.id,
        name: product.name,
        nameAr: product.nameAr ?? '',
        note: product.note ?? '',
        unitPrice: unit,
        qty: item.qty,
        lineTotal: money(unit * item.qty),
      };
      // What is actually inside, copied onto the line like the name and price
      // are, so the order still reads correctly after the bundle is edited.
      if (product.isBundle && product.bundleType === 'choice') {
        line.selections = (item.selections ?? []).map((pick) => {
          const group = product.groups[pick.group];
          const option = group.options.find((entry) => entry.productId === pick.productId);
          const picked = catalogue.get(pick.productId);
          return {
            group: pick.group,
            label: group.label,
            labelAr: group.labelAr ?? '',
            productId: pick.productId,
            name: picked?.name ?? '',
            nameAr: picked?.nameAr ?? '',
            quantity: pick.quantity,
            surcharge: option?.surcharge ?? 0,
          };
        });
      } else if (product.isBundle) {
        line.components = (product.components ?? []).map((component) => ({
          productId: component.productId,
          name: catalogue.get(component.productId)?.name ?? '',
          nameAr: catalogue.get(component.productId)?.nameAr ?? '',
          quantity: component.quantity,
        }));
      }
      return line;
    });

    const order = {
      reference,
      seq,
      customerPhone: phone,
      profileId: null,
      firstName: payload.firstName,
      lastName: payload.lastName || '',
      phone,
      email: payload.email || '',
      fulfilment: payload.fulfilment,
      area: payload.area || '',
      address: payload.address || '',
      building: payload.building || '',
      floor: payload.floor || '',
      apartment: payload.apartment || '',
      landmark: payload.landmark || '',
      notes: payload.notes || '',
      lang: payload.lang || 'en',
      subtotal: totals.subtotal,
      discount: totals.discount,
      delivery: totals.delivery,
      total: totals.total,
      promoCode,
      status: 'ordered',
      paymentMethod: payload.paymentMethod || 'cash',
      paymentStatus: 'unpaid',
      paymentRef: '',
      items,
      history: [{ status: 'ordered', note: 'Order placed', at: Timestamp.now() }],
    };

    // The invariants that used to be SQLite triggers. Asserted inside the
    // transaction and immediately before the write, so a violation aborts the
    // whole thing rather than committing a malformed order.
    assertNewOrder(order);

    // `.create()` so a reference collision fails loudly instead of overwriting
    // an existing order. The counter makes that essentially impossible; this is
    // the belt to its braces, and it costs nothing.
    tx.create(collections.orders().doc(reference), { ...order, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

    upsertCustomerInTransaction(tx, {
      phone,
      firstName: payload.firstName,
      lastName: payload.lastName || '',
      email: payload.email || '',
      orderTotal: totals.total,
    }, customerSnap.exists ? customerSnap.data() : null);

    if (promo) {
      tx.update(collections.promos().doc(promo.code), {
        usedCount: FieldValue.increment(1),
      });
    }

    tx.create(idempotencyRef, {
      requestHash,
      orderRef: reference,
      createdAt: FieldValue.serverTimestamp(),
    });

    return { order: { ...order, createdAt: new Date().toISOString() }, duplicate: false };
  });
}
