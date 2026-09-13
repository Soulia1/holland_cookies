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

export async function getOrder(reference) {
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
 * Two paths, because they have genuinely different costs:
 *
 *   No search term → a real Firestore query with the status filter, ordering and
 *   page window pushed to the server. Reads exactly one page.
 *
 *   Search term → a bounded scan, filtered here. Unavoidable; see SEARCH_SCAN_CAP.
 */
export async function listOrders({ page = 1, perPage = 25, status = null, q = '' } = {}) {
  const needle = String(q ?? '').trim().toLowerCase();

  if (!needle) {
    let query = collections.orders();
    if (status) query = query.where('status', '==', status);

    const counted = await (status
      ? collections.orders().where('status', '==', status)
      : collections.orders()).count().get();
    const total = counted.data().count;

    const snapshot = await query
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

  let scan = collections.orders();
  if (status) scan = scan.where('status', '==', status);
  const snapshot = await scan.orderBy('seq', 'desc').limit(SEARCH_SCAN_CAP).get();

  const matched = snapshot.docs.map(orderFromDoc).filter((order) => [
    order.reference, order.firstName, order.lastName, order.phone, order.email,
  ].some((field) => String(field ?? '').toLowerCase().includes(needle)));

  const start = (page - 1) * perPage;
  return {
    orders: matched.slice(start, start + perPage).map(orderPayload),
    page,
    perPage,
    total: matched.length,
    pages: Math.max(1, Math.ceil(matched.length / perPage)),
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
  const snapshot = await collections.orders().orderBy('seq', 'desc').limit(limit).get();
  return snapshot.docs.map(orderFromDoc);
}

/** Every order for one customer phone, newest first. */
export async function ordersForPhone(phone, limit = 200) {
  const snapshot = await collections.orders()
    .where('phone', '==', phone).orderBy('seq', 'desc').limit(limit).get();
  return snapshot.docs.map(orderFromDoc);
}

/** Every order attached to a proved account. */
export async function ordersForProfile(profileId, limit = 100) {
  const snapshot = await collections.orders()
    .where('profileId', '==', profileId).orderBy('seq', 'desc').limit(limit).get();
  return snapshot.docs.map(orderFromDoc);
}

// ---------------------------------------------------------------- status ----

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

  return db.runTransaction(async (tx) => {
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
  });
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
export async function orderStats({ days = 30 } = {}) {
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

  const [byStatus, byPaymentStatus, byFulfillmentRaw] = await Promise.all([
    countsFor('status', ['ordered', 'confirmed', 'baking', 'in_transit', 'completed', 'cancelled']),
    countsFor('paymentStatus', ['unpaid', 'paid', 'refunded']),
    countsFor('fulfilment', ['delivery', 'pickup']),
  ]);

  const liveValue = money(all.value - cancelled.value);
  const pendingValue = money(Math.max(0, liveValue - paid.value));
  const refundDueValue = money(Math.max(0, cancelledPaid.value));

  // --- the one document read -------------------------------------------------
  const startOfWindow = new Date();
  startOfWindow.setUTCHours(0, 0, 0, 0);
  startOfWindow.setUTCDate(startOfWindow.getUTCDate() - (days - 1));

  const windowed = await orders
    .where('createdAt', '>=', Timestamp.fromDate(startOfWindow))
    .get();
  const inWindow = windowed.docs.map(orderFromDoc);

  const dayKey = (value) => (iso(value) ?? '').slice(0, 10);

  const byDate = new Map();
  const areaCounts = new Map();
  const productTotals = new Map();

  for (const order of inWindow) {
    const key = dayKey(order.createdAt);
    if (!byDate.has(key)) byDate.set(key, { orders: 0, orderValue: 0, paidRevenue: 0 });
    const day = byDate.get(key);
    day.orders += 1;
    day.orderValue += order.total ?? 0;
    if (order.paymentStatus === 'paid') day.paidRevenue += order.total ?? 0;

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
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
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
