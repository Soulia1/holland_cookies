/**
 * Creating an order.
 *
 * This is the file that makes the price in the browser not matter.
 *
 * Everything the client sends about money is ignored. The cart arrives as a
 * list of `{ productId, qty }`; the products are read from the catalogue inside
 * the transaction; the line prices, the subtotal, the discount, the delivery
 * and the total are all computed here from those rows, using the same
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
 * All of it runs inside one SQLite transaction, so an order is never half
 * written: either the order, its lines, its first status entry, the customer
 * record, the promo usage and the reference counter all commit, or none do.
 *
 * `createOrder` is synchronous underneath — better-sqlite3 is — but it is
 * declared `async` so the route can await it and so this stays swappable for a
 * driver that is not.
 */

import { createHash } from 'node:crypto';
import * as db from './db.js';
import { effectivePrice, money, priceOrder } from '../shared/pricing.mjs';

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
 * they typed +20, 0020 or a leading zero. Used as the customer key, so getting
 * this wrong means one person becoming three records.
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
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return { valid: false, reason: 'That code has expired.' };
  }
  if (promo.max_uses > 0 && promo.used_count >= promo.max_uses) {
    return { valid: false, reason: 'That code has been fully redeemed.' };
  }
  if (subtotal < promo.min_subtotal) {
    return {
      valid: false,
      reason: `That code needs a subtotal of at least ${promo.min_subtotal} EGP.`,
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
  const database = db.get();

  const phone = normalizePhone(payload.phone);
  if (!phone) throw fail(400, 'INVALID_PHONE', 'That phone number does not look right.');

  const requestHash = hash(JSON.stringify({
    items: payload.items, phone, fulfilment: payload.fulfilment,
  }));

  const run = database.transaction(() => {
    // --- Idempotency ------------------------------------------------------
    // A retried request returns the original order instead of making a second
    // one. The hash is compared so the same key cannot be reused for a
    // different basket, which would otherwise let a client overwrite the
    // meaning of an order that already exists.
    const seen = database
      .prepare('SELECT * FROM order_idempotency WHERE key = ?')
      .get(payload.idempotencyKey);
    if (seen) {
      if (seen.request_hash !== requestHash) {
        throw fail(409, 'IDEMPOTENCY_CONFLICT',
          'This checkout key was already used for a different order.');
      }
      const existing = database.prepare('SELECT * FROM orders WHERE id = ?').get(seen.order_id);
      return { order: existing, duplicate: true };
    }

    // --- The catalogue, as it is right now ---------------------------------
    const ids = [...new Set(payload.items.map((item) => item.productId))];
    const placeholders = ids.map(() => '?').join(',');
    const rows = database
      .prepare(`SELECT * FROM products WHERE id IN (${placeholders})`)
      .all(...ids);
    const catalogue = new Map(rows.map((row) => [row.id, {
      ...row,
      discountEnabled: !!row.discount_enabled,
      discountType: row.discount_type,
      discountValue: row.discount_value,
    }]));

    const missing = ids.filter((id) => !catalogue.has(id));
    if (missing.length) {
      throw fail(400, 'PRODUCT_MISSING',
        'Something in your cart is no longer on the menu.', { productIds: missing });
    }
    const unavailable = ids.filter((id) => !catalogue.get(id).available);
    if (unavailable.length) {
      throw fail(409, 'PRODUCT_UNAVAILABLE',
        'Something in your cart has sold out.', { productIds: unavailable });
    }

    // --- Settings, and whether the shop is even open ------------------------
    const settingsRow = database.prepare('SELECT * FROM settings WHERE id = 1').get();
    if (!settingsRow.accepting_orders) {
      throw fail(409, 'CLOSED', 'We are not taking orders at the moment.');
    }
    const settings = {
      deliveryFee: settingsRow.delivery_fee,
      freeDeliveryOver: settingsRow.free_delivery_over,
    };

    // --- Price it -----------------------------------------------------------
    const priced = priceOrder({
      items: payload.items,
      catalogue,
      settings,
      fulfilment: payload.fulfilment,
      promoDiscount: 0,
    });

    let discount = 0;
    let promoCode = '';
    let promoRow = null;
    if (payload.promoCode) {
      promoRow = database
        .prepare('SELECT * FROM promos WHERE code = ?')
        .get(payload.promoCode.trim().toUpperCase());
      const result = evaluatePromo(promoRow, priced.subtotal);
      if (!result.valid) throw fail(400, 'INVALID_PROMO', result.reason);
      discount = result.discount;
      promoCode = promoRow.code;
    }

    const totals = priceOrder({
      items: payload.items,
      catalogue,
      settings,
      fulfilment: payload.fulfilment,
      promoDiscount: discount,
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

    // --- Reference ----------------------------------------------------------
    database.prepare("UPDATE counters SET value = value + 1 WHERE name = 'orders'").run();
    const counter = database
      .prepare("SELECT value FROM counters WHERE name = 'orders'").get().value;
    const reference = `HC-${counter}`;

    // --- Customer -----------------------------------------------------------
    // Upserted on the normalised phone, so a returning customer accumulates
    // onto one record instead of creating a new one per order.
    database.prepare(`
      INSERT INTO customers (phone, first_name, last_name, email)
      VALUES (@phone, @firstName, @lastName, @email)
      ON CONFLICT(phone) DO UPDATE SET
        first_name = excluded.first_name,
        last_name  = excluded.last_name,
        email      = CASE WHEN excluded.email <> '' THEN excluded.email ELSE customers.email END,
        updated_at = datetime('now')
    `).run({
      phone,
      firstName: payload.firstName,
      lastName: payload.lastName || '',
      email: payload.email || '',
    });
    const customer = database.prepare('SELECT id FROM customers WHERE phone = ?').get(phone);

    // --- The order ----------------------------------------------------------
    const info = database.prepare(`
      INSERT INTO orders (
        reference, customer_id, first_name, last_name, phone, email,
        fulfilment, area, address, building, floor, apartment, landmark, notes, lang,
        subtotal, discount, delivery, total, promo_code, status, payment_method, payment_status
      ) VALUES (
        @reference, @customerId, @firstName, @lastName, @phone, @email,
        @fulfilment, @area, @address, @building, @floor, @apartment, @landmark, @notes, @lang,
        @subtotal, @discount, @delivery, @total, @promoCode, 'ordered', @paymentMethod, 'unpaid'
      )
    `).run({
      reference,
      customerId: customer.id,
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
      paymentMethod: payload.paymentMethod || 'cash',
    });
    const orderId = info.lastInsertRowid;

    // --- Lines --------------------------------------------------------------
    const insertItem = database.prepare(`
      INSERT INTO order_items (order_id, product_id, name, name_ar, note, unit_price, qty, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of payload.items) {
      const product = catalogue.get(item.productId);
      const unit = effectivePrice(product);
      insertItem.run(
        orderId, product.id, product.name, product.name_ar, product.note,
        unit, item.qty, money(unit * item.qty),
      );
    }

    database.prepare(
      "INSERT INTO order_status_history (order_id, status, note) VALUES (?, 'ordered', 'Order placed')",
    ).run(orderId);

    // Customer totals, from the order that was just written rather than from
    // anything the client claimed.
    database.prepare(`
      UPDATE customers SET orders_count = orders_count + 1,
                           total_spent = total_spent + ?,
                           updated_at = datetime('now')
      WHERE id = ?
    `).run(totals.total, customer.id);

    if (promoRow) {
      database.prepare('UPDATE promos SET used_count = used_count + 1 WHERE code = ?')
        .run(promoRow.code);
    }

    database.prepare(
      'INSERT INTO order_idempotency (key, request_hash, order_id) VALUES (?, ?, ?)',
    ).run(payload.idempotencyKey, requestHash, orderId);

    return {
      order: database.prepare('SELECT * FROM orders WHERE id = ?').get(orderId),
      duplicate: false,
    };
  });

  return run();
}

