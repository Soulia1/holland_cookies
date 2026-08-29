/**
 * Money, as the operator has to collect it.
 *
 * Whole pounds print exactly as they always did; piastres are only shown when
 * there are some. Rounding them away was harmless while every price was a whole
 * number, but a percentage discount makes 85 into 72.25, and this is the figure
 * an operator reads off the screen to take cash for.
 */
export function formatEGP(n: number): string {
  const value = Math.round((Number(n) || 0) * 100) / 100;
  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  })} EGP`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-EG", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Today's date in Africa/Cairo as 'YYYY-MM-DD' — matches the format the server
// stores on order.deliveryDate, so "today's deliveries" can compare directly.
export function cairoToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Mirrors backend/fulfillment.js's DELIVERY_TIME_SLOTS — the order stores only
// the id, so the dashboard needs the same id → label table to show it.
const DELIVERY_TIME_SLOT_LABELS: Record<string, string> = {
  "12-2pm": "12:00 PM – 2:00 PM",
  "4-6pm": "4:00 PM – 6:00 PM",
};

export function deliveryTimeSlotLabel(id?: string | null): string {
  if (!id) return "";
  return DELIVERY_TIME_SLOT_LABELS[id] || id;
}

export function formatDeliveryDate(ymd?: string | null): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const label = dt.toLocaleDateString("en-EG", { day: "2-digit", month: "short" });
  return ymd === cairoToday() ? `${label} · Today` : label;
}

/**
 * What is actually inside one order line, flattened to `qty × name` parts.
 *
 * A bundle arrives in one of two shapes and BOTH have to be read: a choice
 * bundle carries the customer's picks in `selections`, a fixed bundle carries
 * the admin-defined contents in `components`. Only `selections` used to be
 * handled, so every fixed bundle showed up in the dashboard as a bare name
 * with no way for the kitchen to know what to bake.
 */
export function bundleContents(item: {
  selections?: { name: string; quantity: number }[];
  components?: { name: string; quantityPerBundle: number; totalQuantity: number }[];
}): string[] {
  if (item.selections?.length) {
    return item.selections.map((s) => `${s.quantity}× ${s.name}`);
  }
  if (item.components?.length) {
    // Per bundle, not the line total — the line quantity is already shown
    // beside the bundle's own name, and doubling it up reads as a mistake.
    return item.components.map((c) => `${c.quantityPerBundle}× ${c.name}`);
  }
  return [];
}

export function summariseItems(
  items: {
    name: string;
    qty: number;
    emoji?: string;
    selections?: { name: string; quantity: number }[];
    components?: { name: string; quantityPerBundle: number; totalQuantity: number }[];
  }[]
): string {
  if (!Array.isArray(items) || !items.length) return "—";
  return items
    .map((i) => {
      const line = `${i.emoji || ""} ${i.name} ×${i.qty}`;
      // A bundle's name alone ("3-Cookie Bundle") does not tell the kitchen
      // what to bake, so its contents are spelled out inline.
      const inner = bundleContents(i);
      return inner.length ? `${line} (${inner.join(", ")})` : line;
    })
    .join(", ");
}

export const TIME_RANGES = ["7d", "1m", "3m", "6m"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "7d": "7 Days",
  "1m": "1 Month",
  "3m": "3 Months",
  "6m": "6 Months",
};

export const TIME_RANGE_DAYS: Record<TimeRange, number> = {
  "7d": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
};

export function rangeStartDate(range: TimeRange): Date {
  const d = new Date();
  d.setDate(d.getDate() - TIME_RANGE_DAYS[range]);
  return d;
}

/** 1,240 → "1.2K". Keeps the headline figures to a single line. */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    Math.round(n)
  );
}

export function formatCompactEGP(n: number): string {
  return `${formatCompact(n)} EGP`;
}

/** Period-over-period change, or null when the prior period had nothing to
 *  compare against — showing "+100%" against a zero baseline is meaningless. */
export function percentChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}
