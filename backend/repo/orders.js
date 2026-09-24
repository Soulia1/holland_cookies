/**
 * Orders: reading them, listing them, moving them through their states, and the
 * aggregates the dashboard overview is built on.
 *
 * ## Document shape, and why the lines moved onto the order
 *
 * SQLite kept `orders`, `order_items` and `order_status_history` as three tables
 * joined on an order id. Here the items and the history are *arrays on the order
 * document*, and that is the single most consequential modelling decision in the
 * migration. It is worth the paragraph:
 *
 *   - It makes an order atomic by construction. §52 of the launch brief asks for
 *     protection against "order created but order items missing". With three
 *     collections that is a real failure mode you have to defend against with a
 *     transaction. With one document it is not expressible — the items are the
 *     same write as the order, so a half-written order cannot exist.
 *   - It makes reading an order one read instead of 1 + N. The dashboard list
 *     shows 25 orders with their lines; that was 26 queries against SQLite and
 *     would have been 26 round trips against Firestore.
 *   - It lets `assertNewOrder` check that the lines sum to the subtotal, which
 *     SQLite could not do because the check spanned two tables.
 *
 * The cost is the 1 MiB document limit, which for an order capped at 60 lines is
 * not close to reachable, and that orders can no longer be queried *by* their
 * line contents — nothing did.
 *
 * `seq` is the allocated counter value. Orders are ordered by it rather than by
 * `createdAt`, because two orders placed in the same millisecond would otherwise
 * have no stable order, and pagination over an unstable sort silently skips and
 * repeats rows.
 */

import { collections, FieldValue, Timestamp } from '../firestore.js';
import { AggregateField } from 'firebase-admin/firestore';
import { money } from '../../shared/pricing.mjs';
import { assertOrderUpdate } from '../invariants.js';
import { validateStatusTransition } from '../../shared/orderStatus.mjs';
import { shopDateOf, shopDays } from '../../shared/cairoTime.mjs';
import { buildOrderSearchIndex, parseSearchQuery, queryOrders } from '../../shared/orderSearch.mjs';
import { live, refresh } from '../mirror.js';

const now = () => FieldValue.serverTimestamp();
const iso = (value) => (value?.toDate ? value.toDate().toISOString() : (value ?? null));

/**
 * How far back a substring search will scan.
 *
 * Firestore has no substring operator, so a search over reference/name/phone is
 * a read-and-filter exactly as it was in SQLite (where a leading-wildcard LIKE
 * could not use an index either). The difference is that Firestore reads cost
 * money, so the scan is explicitly bounded here rather than being unbounded and
 * merely small in practice. Beyond this many orders, search needs a real index;
 * that limit is documented rather than discovered on a bill.
 */
const SEARCH_SCAN_CAP = 5000;

/** The same bound, for the customer directory's lifetime aggregates. */
const REPORTING_CAP = 20000;

export const orderFromDoc = (doc) => ({ reference: doc.id, ...doc.data() });

/** The API shape. Unchanged from the SQLite implementation. */
export function orderPayload(order) {
  return {
    reference: order.reference,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    fulfilment: order.fulfilment,
    createdAt: iso(order.createdAt),
    customer: {
      firstName: order.firstName ?? '',
      lastName: order.lastName ?? '',
      phone: order.phone ?? '',
      email: order.email ?? '',
    },
    delivery: {
      area: order.area ?? '',
      address: order.address ?? '',
      building: order.building ?? '',
      floor: order.floor ?? '',
      apartment: order.apartment ?? '',
      landmark: order.landmark ?? '',
      notes: order.notes ?? '',
    },
    items: (order.items ?? []).map((item) => ({
      productId: item.productId,
      name: item.name,
      nameAr: item.nameAr || undefined,
      note: item.note || undefined,
      unitPrice: item.unitPrice,
      qty: item.qty,
      lineTotal: item.lineTotal,
      ...(item.choice?.name
        ? {
          choice: {
            name: item.choice.name,
            nameAr: item.choice.nameAr || undefined,
            priceDelta: Number(item.choice.priceDelta) || 0,
          },
        }
        : {}),
      ...(item.selections?.length ? {
        selections: item.selections.map((pick) => ({
          group: pick.group,
          label: pick.label,
          labelAr: pick.labelAr || undefined,
          productId: pick.productId,
          name: pick.name,
          nameAr: pick.nameAr || undefined,
          quantity: pick.quantity,
          surcharge: pick.surcharge,
        })),
      } : {}),
      ...(item.components?.length ? {
        components: item.components.map((component) => ({
          productId: component.productId,
          name: component.name,
          nameAr: component.nameAr || undefined,
          quantity: component.quantity,
        })),
      } : {}),
    })),
    totals: {
      subtotal: order.subtotal,
      discount: order.discount,
      delivery: order.delivery,
      total: order.total,
    },
    promoCode: order.promoCode || undefined,
  };
}

export const historyOut = (order) => (order.history ?? []).map((entry) => ({
  status: entry.status,
  note: entry.note ?? '',
  created_at: iso(entry.at),
}));

/**
 * Every order, newest first, from the mirror — or null when the mirror cannot
 * answer and the caller has to ask Firestore. Shared between requests and
 * rebuilt only when an order changes, so treat it as read-only.
 */
function mirroredOrders() {
  const mirror = live('orders');
  if (!mirror) return null;
  return mirror.derive('bySeq', () => mirror.docs()
    .map(([reference, data]) => wrapOrder(reference, data))
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)));
}

/**
 * One object per version of an order, reused across rebuilds of the list, so
 * the search index below survives other orders changing.
 */
const wrappedOrders = new WeakMap();
function wrapOrder(reference, data) {
  let order = wrappedOrders.get(data);
  if (!order) {
    order = { reference, ...data };
    wrappedOrders.set(data, order);
  }
  return order;
}

/**
 * The dashboard's order shape, as the shared matcher reads it. The matcher is
 * the same one the dashboard highlights with, so a row the API finds is a row
 * the table can mark up.
 */
function searchShape(order) {
  return {
    orderId: order.reference,
    name: `${order.firstName ?? ''} ${order.lastName ?? ''}`.trim(),
    phone: order.phone,
    email: order.email,
    address: order.address,
    area: order.area,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    status: order.status,
    fulfillmentType: order.fulfilment,
    promoCode: order.promoCode,
    items: order.items,
    createdAt: iso(order.createdAt),
  };
}

/**
 * The search index for an order, built once per version of it. Keyed on the
 * order object, which the mirror replaces whenever the document changes, so a
 * keystroke re-scores thousands of orders without re-normalising any of them.
 */
const searchIndexes = new WeakMap();
function searchIndexOf(order) {
  let index = searchIndexes.get(order);
  if (!index) {
    index = buildOrderSearchIndex(searchShape(order));
    searchIndexes.set(order, index);
  }
  return index;
}

export async function getOrder(reference) {
  const id = String(reference).toUpperCase();
  const mirror = live('orders');
  if (mirror) {
    const data = mirror.get(id);
    return data ? { reference: id, ...data } : null;
  }
  const doc = await collections.orders().doc(String(reference).toUpperCase()).get();
  return doc.exists ? orderFromDoc(doc) : null;
}

/** Tracking lookup: reference AND phone, both required. */
export async function getOrderForTracking(reference, phone) {
  const order = await getOrder(reference);
  // One outcome for "no such reference" and for "wrong phone" alike: telling
  // them apart would confirm which references exist, and references are
  // sequential by design.
  return order && order.phone === phone ? order : null;
}

// ------------------------------------------------------------------ list ----

/**
 * The dashboard list.
 *
 * Served from the orders mirror: filtering, ranking and paging over memory,
 * with no round trip. Search uses the shared matcher (shared/orderSearch.mjs),
 * so Arabic letter variants, Arabic-Indic digits and any spelling of a phone
 * number find the same order the dashboard then highlights. The filtering and
 * ranking are `queryOrders`, which the dashboard also runs in the browser over
 * the order book (`orderBook` below), so the two always agree.
 *
 * While the mirror is not serving, the two old Firestore paths answer instead:
 * a real query for the unsearched list, and a bounded scan (SEARCH_SCAN_CAP)
 * for a search, because Firestore has no substring operator.
 */
export async function listOrders({ page = 1, perPage = 25, status = null, fulfilment = null, q = '' } = {}) {
  const answer = (rows) => {
    const result = queryOrders(rows, { page, perPage, q, status, fulfilment }, searchIndexOf);
    return { orders: result.rows.map(orderPayload), page, perPage, total: result.total, pages: result.pages };
  };

  const mirrored = mirroredOrders();
  if (mirrored) return answer(mirrored);

  // The mirror is not serving (booting, or its listener is reconnecting), so
  // ask Firestore — the path this module used before the mirror existed.
  const filtered = () => {
    let query = collections.orders();
    if (status) query = query.where('status', '==', status);
    if (fulfilment) query = query.where('fulfilment', '==', fulfilment);
    return query;
  };

  if (parseSearchQuery(q ?? '').empty) {
    const total = (await filtered().count().get()).data().count;
    const snapshot = await filtered()
      .orderBy('seq', 'desc')
      .offset((page - 1) * perPage)
      .limit(perPage)
      .get();
    return {
      orders: snapshot.docs.map((doc) => orderPayload(orderFromDoc(doc))),
      page,
      perPage,
      total,
      pages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  const snapshot = await filtered().orderBy('seq', 'desc').limit(SEARCH_SCAN_CAP).get();
  return answer(snapshot.docs.map(orderFromDoc));
}

/**
 * How many of the newest orders the dashboard holds in the browser. Past this
 * its local answers are marked incomplete and the server is still asked, so a
 * search never silently misses an old order; below it — which is this shop for
 * a long while — searching, filtering and paging never leave the browser.
 */
export const ORDER_BOOK_LIMIT = 3000;

/** Distinguishes this process's versions from a previous one's after a restart. */
const BOOT = Date.now().toString(36);

/**
 * The newest orders, whole, for the dashboard to search and page in the
 * browser: a keystroke there is then no request at all.
 *
 * `version` names this exact answer and is cheap to compute, so an unchanged
 * book is answered with a 304 before anything is built or serialised. It is
 * null while the mirror is not serving — the Firestore read below cannot say
 * cheaply whether anything changed, so every answer is then a full one.
 */
export function orderBookVersion(limit = ORDER_BOOK_LIMIT) {
  const mirror = live('orders');
  return mirror ? `${BOOT}.${mirror.generation}.${limit}` : null;
}

export async function orderBook(limit = ORDER_BOOK_LIMIT) {
  const mirror = live('orders');
  if (mirror) {
    return mirror.derive(`book:${limit}`, () => {
      const all = mirroredOrders();
      return {
        version: orderBookVersion(limit),
        orders: all.slice(0, limit).map(orderPayload),
        total: all.length,
        complete: all.length <= limit,
      };
    });
  }
  const [count, snapshot] = await Promise.all([
    collections.orders().count().get(),
    collections.orders().orderBy('seq', 'desc').limit(limit).get(),
  ]);
  const total = count.data().count;
  return {
    version: null,
    orders: snapshot.docs.map((doc) => orderPayload(orderFromDoc(doc))),
    total,
    complete: total <= limit,
  };
}

/**
 * Every order, for the customer directory.
 *
 * This is the one genuinely expensive read in the system and it is named
 * honestly so that nobody adds a second caller without noticing. The directory
 * page computes lifetime totals per customer, and a lifetime total over one page
 * of orders is not a lifetime total, so there is no paginated version of this
 * that answers the question.
 *
 * Bounded by REPORTING_CAP rather than unbounded: past that point the page needs
 * a maintained aggregate rather than a bigger read, and returning a silently
 * partial answer is better than an unbounded bill. The cap is far above this
 * shop's realistic order count.
 */
export async function listAllOrdersForReporting(limit = REPORTING_CAP) {
  const mirrored = mirroredOrders();
  if (mirrored) return mirrored.slice(0, limit);
  const snapshot = await collections.orders().orderBy('seq', 'desc').limit(limit).get();
  return snapshot.docs.map(orderFromDoc);
}

/** Every order for one customer phone, newest first. */
export async function ordersForPhone(phone, limit = 200) {
  const mirrored = mirroredOrders();
  if (mirrored) return mirrored.filter((order) => order.phone === phone).slice(0, limit);
  const snapshot = await collections.orders()
    .where('phone', '==', phone).orderBy('seq', 'desc').limit(limit).get();
  return snapshot.docs.map(orderFromDoc);
}

/** Every order attached to a proved account. */
export async function ordersForProfile(profileId, limit = 100) {
  const mirrored = mirroredOrders();
  if (mirrored) return mirrored.filter((order) => order.profileId === profileId).slice(0, limit);
  const snapshot = await collections.orders()
    .where('profileId', '==', profileId).orderBy('seq', 'desc').limit(limit).get();
  return snapshot.docs.map(orderFromDoc);
}

// ---------------------------------------------------------------- status ----

/** Once a write to this order has committed, show it to the next read. */
async function afterOrderWrite(reference, write) {
  const result = await write;
  if (result.order) await refresh('orders', reference);
  return result;
}

/**
 * Move an order to a new state.
 *
 * The transition is validated against the shared state machine, then applied in
 * a transaction that re-reads the order and refuses if its status moved in the
 * meantime. That compare-and-set is what makes two dashboards clicking at once
 * deterministic: the second one fails rather than overwriting the first.
 *
 * The status, the history entry and the audit event commit together or not at
 * all — an order whose status moved with no record of who moved it or when is
 * exactly the row somebody will be arguing about later.
 */
export async function changeOrderStatus(reference, nextStatus, note, { actor = 'admin', requestId = '' } = {}) {
  const ref = collections.orders().doc(String(reference).toUpperCase());
  const db = collections.orders().firestore;

  return afterOrderWrite(ref.id, db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { found: false };
    const order = orderFromDoc(snapshot);

    const transition = validateStatusTransition(order.status, nextStatus, order.fulfilment);
    if (!transition.valid) return { found: true, rejected: transition.reason };

    const update = { status: nextStatus, updatedAt: now() };
    assertOrderUpdate(order, update);

    tx.update(ref, {
      ...update,
      history: FieldValue.arrayUnion({
        status: nextStatus,
        note: note ?? '',
        // arrayUnion cannot contain a serverTimestamp sentinel, so the moment is
        // taken here. It is within milliseconds of the commit and is only ever
        // read as a display timestamp.
        at: Timestamp.now(),
      }),
    });

    tx.create(collections.auditEvents().doc(), {
      actor,
      action: `order_status:${order.status}->${nextStatus}`,
      resource: order.reference,
      requestId,
      createdAt: now(),
    });

    return { found: true, order: { ...order, status: nextStatus } };
  }));
}

/**
 * Record whether the cash for an order has been collected.
 *
 * Cash on delivery is the only payment method, so `paymentStatus` is internal
 * bookkeeping: `paid` means the driver or the counter has the money, `unpaid`
 * undoes a misclick. Cash changes hands at the handover, so it can be marked
 * collected only once the order is completed; a cancelled order has nothing to
 * collect. The change and its audit event commit together.
 */
export async function setCashCollected(reference, collected, { actor = 'admin', requestId = '' } = {}) {
  const ref = collections.orders().doc(String(reference).toUpperCase());
  const db = collections.orders().firestore;

  return afterOrderWrite(ref.id, db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return { found: false };
    const order = orderFromDoc(snapshot);

    if (order.paymentMethod !== 'cash') {
      return { found: true, rejected: 'Only cash orders are recorded here.' };
    }
    const paymentStatus = collected ? 'paid' : 'unpaid';
    if (order.paymentStatus === paymentStatus) {
      return { found: true, rejected: collected ? 'The cash is already marked as collected.' : 'The cash is already marked as not collected.' };
    }
    if (collected && order.status !== 'completed') {
      return { found: true, rejected: 'Cash can be marked collected once the order is completed.' };
    }

    const update = { paymentStatus, updatedAt: now() };
    assertOrderUpdate(order, update);
    tx.update(ref, update);
    tx.create(collections.auditEvents().doc(), {
      actor,
      action: `cash:${order.paymentStatus}->${paymentStatus}`,
      resource: order.reference,
      requestId,
      createdAt: now(),
    });
    return { found: true, order: { ...order, paymentStatus } };
  }));
}

// ------------------------------------------------------------------ stats ----

/**
 * The overview aggregates.
 *
 * This is the endpoint the migration cost the most thought, because Firestore
 * has neither GROUP BY nor SUM in its query language, and the SQLite version was
 * eleven aggregate queries over the whole orders table.
 *
 * What it does instead, and why:
 *
 *   The scalar totals and the group counts use Firestore *aggregation queries*
 *   (`count()`, `sum()`). These are answered from the index without returning
 *   documents and are billed at roughly one read per thousand index entries, so
 *   they keep the exact all-time semantics the SQL had at a small fraction of
 *   the cost of reading the collection.
 *
 *   `daily`, `byArea` and `topProducts` cannot be expressed that way — they are
 *   GROUP BY over a field, and over the contents of an array field in the case
 *   of products. Those need documents. So there is exactly ONE document read
 *   here, bounded to the requested window, and all three are computed from it.
 *
 * ### One deliberate change in meaning, recorded rather than hidden
 *
 * In the SQLite version `byArea` and `topProducts` had no date filter: they were
 * all-time, sitting next to a windowed chart. They are now computed over the
 * same window as everything else on the screen. That is a behaviour change. It
 * was chosen because reading every order on every dashboard load is precisely
 * what §95/§119 of the brief say not to do, and because "top products this
 * month" beside "orders this month" is the more useful and more coherent
 * reading. `days` is already in the response so the window is not a secret.
 */
const STATUS_KEYS = ['ordered', 'confirmed', 'baking', 'in_transit', 'completed', 'cancelled'];
const PAYMENT_KEYS = ['unpaid', 'paid', 'refunded'];
const FULFILMENT_KEYS = ['delivery', 'pickup'];

/**
 * The same figures the Firestore aggregates produce, computed over the mirror.
 * Kept faithful to Firestore's semantics rather than to what reads naturally:
 * `sum()` skips a non-numeric total, a range filter on `createdAt` only matches
 * real timestamps, and range results come back oldest first.
 */
function statsFromMemory(orders, windowStart) {
  const sumOf = (rows) => ({
    value: rows.reduce((sum, order) => sum + (typeof order.total === 'number' ? order.total : 0), 0),
    count: rows.length,
  });
  const countsFor = (field, values) => Object.fromEntries(values
    .map((value) => [value, orders.filter((order) => order[field] === value).length])
    .filter(([, count]) => count > 0));
  const cancelledRows = orders.filter((order) => order.status === 'cancelled');
  const startMs = windowStart.getTime();
  return {
    all: sumOf(orders),
    paid: sumOf(orders.filter((order) => order.paymentStatus === 'paid')),
    fulfilled: sumOf(orders.filter((order) => order.status === 'completed')),
    cancelled: sumOf(cancelledRows),
    cancelledPaid: sumOf(cancelledRows.filter((order) => order.paymentStatus === 'paid')),
    byStatus: countsFor('status', STATUS_KEYS),
    byPaymentStatus: countsFor('paymentStatus', PAYMENT_KEYS),
    byFulfillmentRaw: countsFor('fulfilment', FULFILMENT_KEYS),
    inWindow: orders
      .filter((order) => typeof order.createdAt?.toMillis === 'function' && order.createdAt.toMillis() >= startMs)
      .sort((a, b) => a.createdAt.seconds - b.createdAt.seconds
        || a.createdAt.nanoseconds - b.createdAt.nanoseconds
        || (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0)),
  };
}

/** The overview figures straight from Firestore, for when the mirror cannot answer. */
async function statsFromFirestore(windowStart) {
  const orders = collections.orders();

  const sumOf = async (query) => {
    const result = await query.aggregate({
      value: AggregateField.sum('total'),
      count: AggregateField.count(),
    }).get();
    return { value: result.data().value ?? 0, count: result.data().count ?? 0 };
  };

  const [all, paid, fulfilled, cancelled, cancelledPaid] = await Promise.all([
    sumOf(orders),
    sumOf(orders.where('paymentStatus', '==', 'paid')),
    sumOf(orders.where('status', '==', 'completed')),
    sumOf(orders.where('status', '==', 'cancelled')),
    sumOf(orders.where('status', '==', 'cancelled').where('paymentStatus', '==', 'paid')),
  ]);

  const countsFor = async (field, values) => Object.fromEntries(
    (await Promise.all(values.map(async (value) => {
      const result = await orders.where(field, '==', value).count().get();
      return [value, result.data().count];
    }))).filter(([, count]) => count > 0),
  );

  const [byStatus, byPaymentStatus, byFulfillmentRaw, windowed] = await Promise.all([
    countsFor('status', STATUS_KEYS),
    countsFor('paymentStatus', PAYMENT_KEYS),
    countsFor('fulfilment', FULFILMENT_KEYS),
    orders.where('createdAt', '>=', Timestamp.fromDate(windowStart)).get(),
  ]);

  return {
    all, paid, fulfilled, cancelled, cancelledPaid, byStatus, byPaymentStatus, byFulfillmentRaw,
    inWindow: windowed.docs.map(orderFromDoc),
  };
}

export async function orderStats({ days = 30, topDays = days } = {}) {
  // Days are Cairo days. Bucketed by UTC, an order placed between midnight and
  // 02:00/03:00 in Cairo was counted on the day before.
  const span = shopDays(days);
  const windowStart = new Date(span.start);
  const mirrored = mirroredOrders();
  // From the mirror, the figures only change when an order does (or the Cairo
  // day rolls over, which changes span.start), so they are computed once per
  // change rather than once per dashboard load.
  if (mirrored) {
    return live('orders').derive(`stats:${days}:${topDays}:${span.start}`,
      () => summarise(statsFromMemory(mirrored, windowStart), span, days, topDays));
  }
  return summarise(await statsFromFirestore(windowStart), span, days, topDays);
}

/** The overview response, from the raw figures of either source. */
function summarise(figures, span, days, topDays) {
  const {
    all, paid, fulfilled, cancelled, cancelledPaid, byStatus, byPaymentStatus, byFulfillmentRaw, inWindow,
  } = figures;

  const liveValue = money(all.value - cancelled.value);
  const pendingValue = money(Math.max(0, liveValue - paid.value));
  const refundDueValue = money(Math.max(0, cancelledPaid.value));

  // The dashboard asks for twice its range so it can compare with the period
  // before; best sellers and areas cover only the range itself.
  const topDates = new Set(span.dates.slice(-topDays));

  const byDate = new Map();
  const areaCounts = new Map();
  const productTotals = new Map();

  for (const order of inWindow) {
    const key = shopDateOf(iso(order.createdAt));
    if (!byDate.has(key)) byDate.set(key, { orders: 0, orderValue: 0, paidRevenue: 0 });
    const day = byDate.get(key);
    day.orders += 1;
    day.orderValue += order.total ?? 0;
    if (order.paymentStatus === 'paid') day.paidRevenue += order.total ?? 0;

    if (!topDates.has(key)) continue;
    if (order.fulfilment === 'delivery' && order.area) {
      areaCounts.set(order.area, (areaCounts.get(order.area) ?? 0) + 1);
    }
    for (const item of order.items ?? []) {
      const entry = productTotals.get(item.name) ?? { quantity: 0, value: 0 };
      entry.quantity += item.qty ?? 0;
      entry.value += item.lineTotal ?? 0;
      productTotals.set(item.name, entry);
    }
  }

  // Dense: a day with no orders appears as a zero rather than being absent, or
  // the area chart draws a straight line across it and invents trade that never
  // happened.
  const daily = [];
  for (const key of span.dates) {
    const row = byDate.get(key);
    daily.push({
      date: key,
      orders: row?.orders ?? 0,
      orderValue: money(row?.orderValue ?? 0),
      paidRevenue: money(row?.paidRevenue ?? 0),
    });
  }

  return {
    totals: {
      orderValue: money(all.value),
      paidRevenue: money(paid.value),
      fulfilledRevenue: money(fulfilled.value),
      cancelledValue: money(cancelled.value),
      liveValue,
      pendingValue,
      refundDueValue,
      count: all.count,
      averageOrderValue: all.count ? money(all.value / all.count) : 0,
    },
    byStatus,
    byPaymentStatus,
    byFulfillment: {
      delivery: byFulfillmentRaw.delivery ?? 0,
      pickup: byFulfillmentRaw.pickup ?? 0,
    },
    byArea: [...areaCounts.entries()]
      .map(([area, count]) => ({ area, count }))
      .sort((a, b) => b.count - a.count).slice(0, 12),
    topProducts: [...productTotals.entries()]
      .map(([name, entry]) => ({ name, quantity: entry.quantity, value: money(entry.value) }))
      .sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    daily,
    days,
    orderCount: all.count,
  };
}

export { iso, SEARCH_SCAN_CAP, REPORTING_CAP };
