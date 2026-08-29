// Delivery areas have exactly one source of truth: the backend's
// DEFAULT_DELIVERY_AREAS, which validateFulfillment enforces on every order and
// which reaches this app as settings.fulfillment.deliveryAreas. The Settings
// page used to spell "Sheikh Zayed" into the markup and so claimed the store
// refuses 6th of October, which the server has always accepted. Nothing in the
// dashboard may name an area literally — render this from the server's list.

export function deliveryAreasSummary(areas: string[]): string {
  const named = areas.map((area) => area.trim()).filter(Boolean);
  if (named.length === 0) return "No delivery areas configured";
  if (named.length === 1) return named[0];
  return `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
}

// Cutoff hours are stored and sent to the backend as a 0–23 integer (Cairo
// time). These convert that to/from the 12-hour + AM/PM shape the settings UI
// shows, without changing what's persisted.
export function hour24ToClock(hour: number): { hour12: number; period: "AM" | "PM" } {
  const h = ((hour % 24) + 24) % 24;
  const period: "AM" | "PM" = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return { hour12, period };
}

export function clockToHour24(hour12: number, period: "AM" | "PM"): number {
  const h = hour12 % 12;
  return period === "PM" ? h + 12 : h;
}

export function formatHour12(hour: number): string {
  const { hour12, period } = hour24ToClock(hour);
  return `${hour12}:00 ${period}`;
}
