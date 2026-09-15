// The single source of truth for the order status model.
//
// Consumed by all three apps: the Express backend `require()`s it (Node >=22.12,
// which package.json already mandates, supports require() of ESM), and both Vite
// apps import it through the `@shared` alias. Nothing here may import Node
// built-ins or browser globals, or one of those three consumers breaks.
//
// Statuses are fulfillment-neutral; only the *labels* branch on delivery vs
// pickup. The previous model branched the data itself
// (ready_for_pickup/picked_up vs out_for_delivery/delivered), which meant every
// consumer had to re-derive which half of the workflow it was looking at.

export const ORDER_STATUSES = [
  'ordered',
  'confirmed',
  'baking',
  'in_transit',
  'completed',
  'cancelled',
];

// The progress flow, in order. `cancelled` is terminal and deliberately absent:
// it sits outside the stepper rather than at the end of it.
export const STATUS_FLOW = ['ordered', 'confirmed', 'baking', 'in_transit', 'completed'];

export const CANCELLED = 'cancelled';

export const FULFILLMENT_TYPES = ['delivery', 'pickup'];

// Maps every value the `orders` collection has ever held onto the new model.
// Two pairs collapse: this is only lossless because `fulfillmentType` survives
// on the order to re-derive the label. Do not merge these without it.
export const LEGACY_STATUS_MAP = {
  pending: 'ordered',
  confirmed: 'confirmed',
  preparing: 'baking',
  ready_for_pickup: 'in_transit',
  out_for_delivery: 'in_transit',
  picked_up: 'completed',
  delivered: 'completed',
  cancelled: 'cancelled',
};

// Only step 4 and 5 read differently between the two fulfillment types. The
// earlier steps are shared, but they are spelled out per type anyway so that
// adding a divergence later is an edit here rather than a new branch elsewhere.
const STATUS_LABELS = {
  ordered: { delivery: 'Ordered', pickup: 'Ordered' },
  confirmed: { delivery: 'Confirmed', pickup: 'Confirmed' },
  baking: { delivery: 'Baking', pickup: 'Baking' },
  in_transit: { delivery: 'Out for delivery', pickup: 'Ready for pickup' },
  completed: { delivery: 'Delivered', pickup: 'Picked up' },
  cancelled: { delivery: 'Cancelled', pickup: 'Cancelled' },
};

export function isValidStatus(status) {
  return ORDER_STATUSES.includes(status);
}

/** Unknown fulfillment types fall back to delivery, matching the API's own
 *  `order.fulfillmentType || 'delivery'` default so labels never read blank. */
function normaliseFulfillment(fulfillmentType) {
  return fulfillmentType === 'pickup' ? 'pickup' : 'delivery';
}

/**
 * The customer- and admin-facing name for a status on a given order.
 * This is the helper the brief requires be shared rather than duplicated —
 * every surface that renders a status name must come through here.
 */
export function statusLabel(status, fulfillmentType) {
  const entry = STATUS_LABELS[toCurrentStatus(status)];
  if (!entry) return String(status || '');
  return entry[normaliseFulfillment(fulfillmentType)];
}

/** Maps one legacy value forward. Values already in the new model pass through,
 *  so the migration is safe to run twice. */
export function migrateStatus(status) {
  if (isValidStatus(status)) return status;
  return LEGACY_STATUS_MAP[status] || null;
}

// First legacy spelling for each current status, for reading old history rows.
const LEGACY_FOR = {
  ordered: 'pending',
  confirmed: 'confirmed',
  baking: 'preparing',
  in_transit: 'out_for_delivery',
  completed: 'delivered',
  cancelled: 'cancelled',
};

/**
 * Accepts either model and returns the current one.
 *
 * Read paths go through this so the storefront works whether or not the
 * migration has been applied yet — an order still sitting on `pending` renders
 * as "Ordered" rather than as a blank stepper. Write paths deliberately do not:
 * a transition must be expressed in the current vocabulary.
 */
function toCurrentStatus(status) {
  return isValidStatus(status) ? status : LEGACY_STATUS_MAP[status] || status;
}

export function statusIndex(status) {
  return STATUS_FLOW.indexOf(toCurrentStatus(status));
}

export function isTerminal(status) {
  // Normalized, so a not-yet-migrated 'delivered' or 'picked_up' order is still
  // recognised as finished and cannot be moved — least of all cancelled.
  const current = toCurrentStatus(status);
  return current === CANCELLED || current === 'completed';
}

/** Every order may be cancelled until it is terminal; otherwise the only move
 *  is one step forward. No skipping and no going back. */
// The flow is the same for delivery and pickup; the type is accepted so callers never branch.
export function allowedNextStatuses(currentStatus, _fulfillmentType) {
  if (isTerminal(currentStatus)) return [];
  const index = statusIndex(currentStatus);
  if (index === -1) return [];
  const next = STATUS_FLOW[index + 1];
  return next ? [next, CANCELLED] : [CANCELLED];
}

export function validateStatusTransition(currentStatus, nextStatus, fulfillmentType) {
  if (currentStatus === nextStatus) {
    return { valid: false, reason: 'The order already has that status.' };
  }
  const allowed = allowedNextStatuses(currentStatus, fulfillmentType);
  if (!allowed.includes(nextStatus)) {
    const type = normaliseFulfillment(fulfillmentType);
    return {
      valid: false,
      reason: `Cannot move a ${type} order from ${currentStatus} to ${nextStatus}.`,
    };
  }
  return { valid: true };
}

/**
 * The stepper model shared by the confirmation screen and the tracking page.
 * `timestamps` maps status -> ISO string, taken from the order's statusHistory.
 *
 * Exactly one step is `isCurrent` for any non-cancelled status. A cancelled
 * order returns no steps at all — callers render a distinct cancelled state
 * rather than a stepper with a gap in it.
 */
export function statusSteps(status, fulfillmentType, timestamps = {}) {
  const currentStatus = toCurrentStatus(status);
  if (currentStatus === CANCELLED) return [];
  const current = statusIndex(currentStatus);
  if (current === -1) return [];
  // `completed` is the end of the flow, not a stage still under way. Marking
  // only `index < current` as done left the last step rendering as the live
  // one, so an order the shop had already handed over sat with a spinner on
  // "Picked up" — directly contradicting the dashboard, which showed the same
  // order as finished. It stays `isCurrent` as well: it is still the step the
  // order is at, and every renderer treats completed as the stronger signal.
  const finished = currentStatus === 'completed';
  return STATUS_FLOW.map((step, index) => ({
    status: step,
    name: statusLabel(step, fulfillmentType),
    isCompleted: index < current || (finished && index === current),
    isCurrent: index === current,
    // Future steps have no timestamp; the tracking component omits the line
    // entirely rather than rendering an empty one.
    // History rows may still name the legacy status, so a timestamp is looked
    // up under both spellings.
    timestamp: index <= current
      ? timestamps[step] ?? timestamps[LEGACY_FOR[step]]
      : undefined,
  }));
}
