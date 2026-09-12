/**
 * The order invariants.
 *
 * These are not new rules. Every one of them was a SQLite trigger or CHECK
 * constraint before the Firestore migration — `orders_insert_guard`,
 * `orders_update_guard`, `items_insert_guard`, and the pair of append-only
 * guards on `audit_events`. SQLite enforced them inside the storage engine,
 * which meant no code path could get around them: not a buggy route, not a
 * migration script, not somebody at a REPL.
 *
 * Firestore has no equivalent. There are no constraints, no triggers, and no
 * server-side validation hook that runs for Admin SDK writes — the Admin SDK
 * bypasses security rules entirely, so rules cannot be used for this either.
 *
 * So the guarantee has to be rebuilt one level up, and the important part is
 * *where* it is called from. Each of these throws, and each is invoked inside
 * the same Firestore transaction that performs the write, immediately before
 * the write. A throw inside a transaction callback aborts the whole transaction,
 * so a document that violates an invariant is never committed — the check and
 * the write cannot be separated by a later edit that forgets one.
 *
 * This is genuinely weaker than a trigger, because it protects only writes that
 * go through this code. A direct console edit or an ad-hoc script using the
 * Admin SDK will not consult it. That residual risk is the honest cost of the
 * migration and is recorded in docs/FIRESTORE_SCHEMA.md rather than glossed.
 *
 * The tolerance of 0.011 on every money comparison is carried over unchanged.
 * Money is stored as a number rounded to piastres by `shared/pricing.mjs`, and
 * a hundredth of a pound of float dust must not abort a legitimate order; a
 * penny and a half of disagreement is a real arithmetic bug and must.
 */

/** The six states an order can be in. Mirrors shared/orderStatus.mjs. */
const ORDER_STATES = ['ordered', 'confirmed', 'baking', 'in_transit', 'completed', 'cancelled'];

/** Payment states. Cash-on-delivery only, so 'paid' is set by staff, never by a customer. */
const PAYMENT_STATES = ['unpaid', 'paid', 'refunded'];

const MONEY_TOLERANCE = 0.011;
const MAX_ORDER_TOTAL = 1_000_000;
const MAX_ITEM_QTY = 50;

export class InvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvariantError';
    this.status = 500;
    this.code = 'INVARIANT_VIOLATION';
  }
}

function fail(message) {
  throw new InvariantError(`Order invariant violated: ${message}`);
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * A new order, as it must look at the moment it is first written.
 *
 * Was: `orders_insert_guard`. The status/payment triple is pinned rather than
 * merely validated — a brand new order is always `ordered` / `unpaid` / `cash`,
 * and an order that arrives already marked paid is a forged request, not an
 * unusual one.
 */
export function assertNewOrder(order) {
  for (const field of ['subtotal', 'discount', 'delivery', 'total']) {
    if (!finite(order[field])) fail(`${field} must be a finite number`);
    if (order[field] < 0) fail(`${field} must not be negative`);
  }
  if (order.total > MAX_ORDER_TOTAL) fail(`total exceeds ${MAX_ORDER_TOTAL}`);
  if (order.discount > order.subtotal) fail('discount exceeds subtotal');

  const expected = order.subtotal - order.discount + order.delivery;
  if (Math.abs(order.total - expected) > MONEY_TOLERANCE) {
    fail(`total ${order.total} does not equal subtotal - discount + delivery (${expected})`);
  }

  if (order.status !== 'ordered') fail("a new order must have status 'ordered'");
  if (order.paymentStatus !== 'unpaid') fail("a new order must be 'unpaid'");
  if (order.paymentMethod !== 'cash') fail("a new order must be 'cash'");

  if (!Array.isArray(order.items) || order.items.length === 0) fail('an order must have items');
  if (order.items.length > 60) fail('an order may not have more than 60 lines');
  for (const item of order.items) assertOrderItem(item);

  // The lines must add up to the subtotal. SQLite could not check this one — it
  // spanned two tables — so this is the single invariant that is *stronger*
  // after the migration, gained because the items now live on the order
  // document and are visible to the same check.
  const lines = order.items.reduce((sum, item) => sum + item.lineTotal, 0);
  if (Math.abs(lines - order.subtotal) > MONEY_TOLERANCE) {
    fail(`line totals (${lines}) do not sum to subtotal (${order.subtotal})`);
  }
  return order;
}

/**
 * One line of an order.
 *
 * Was: `items_insert_guard`.
 */
export function assertOrderItem(item) {
  if (!Number.isInteger(item.qty)) fail('quantity must be a whole number');
  if (item.qty < 1) fail('quantity must be at least 1');
  if (item.qty > MAX_ITEM_QTY) fail(`quantity must not exceed ${MAX_ITEM_QTY}`);
  if (!finite(item.unitPrice) || item.unitPrice < 0) fail('unit price must be a non-negative number');
  if (!finite(item.lineTotal) || item.lineTotal < 0) fail('line total must be a non-negative number');
  if (Math.abs(item.lineTotal - item.qty * item.unitPrice) > MONEY_TOLERANCE) {
    fail(`line total ${item.lineTotal} does not equal qty x unit price`);
  }
  return item;
}

/**
 * An update to an order that already exists.
 *
 * Was: `orders_update_guard`. Money is immutable after the order is placed. The
 * dashboard can move an order through its fulfilment states and nothing else —
 * there is deliberately no route that edits a total, because a receipt that can
 * be rewritten after the fact is not a receipt.
 *
 * `paymentStatus` is the one financial field that is allowed to move, because
 * cash is collected after the order is placed and somebody has to record that.
 * It is constrained to the known states and is admin-only at the route layer.
 */
export function assertOrderUpdate(previous, next) {
  for (const field of ['subtotal', 'discount', 'delivery', 'total', 'paymentMethod']) {
    if (Object.hasOwn(next, field) && next[field] !== previous[field]) {
      fail(`${field} is immutable once an order exists`);
    }
  }
  if (Object.hasOwn(next, 'reference') && next.reference !== previous.reference) {
    fail('reference is immutable');
  }
  if (Object.hasOwn(next, 'items')) fail('order lines are immutable once an order exists');

  if (Object.hasOwn(next, 'status') && !ORDER_STATES.includes(next.status)) {
    fail(`unknown status '${next.status}'`);
  }
  if (Object.hasOwn(next, 'paymentStatus') && !PAYMENT_STATES.includes(next.paymentStatus)) {
    fail(`unknown payment status '${next.paymentStatus}'`);
  }
  return next;
}

/**
 * An audit event.
 *
 * Was: the `audit_no_update` / `audit_no_delete` trigger pair, which made the
 * table append-only at the storage layer. Firestore cannot express that for
 * Admin SDK writes, so append-only is enforced by discipline instead: this is
 * the only writer, it only ever calls `.create()` on a fresh auto-id document,
 * and there is no update or delete path anywhere in `backend/`.
 *
 * `.create()` rather than `.set()` is the load-bearing detail — it fails if the
 * document already exists, so an event can never overwrite an earlier one even
 * if an id were somehow reused.
 */
export function assertAuditEvent(event) {
  for (const field of ['actor', 'action', 'resource']) {
    if (typeof event[field] !== 'string' || !event[field]) fail(`audit event needs a ${field}`);
    if (event[field].length > 200) fail(`audit ${field} is too long`);
  }
  return event;
}

export { ORDER_STATES, PAYMENT_STATES, MONEY_TOLERANCE, MAX_ORDER_TOTAL, MAX_ITEM_QTY };
