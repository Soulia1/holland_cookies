/**
 * The shop's calendar.
 *
 * Holland is a Cairo bakery, so a date typed into the dashboard means a day in
 * Cairo. A promo code set to expire on 30 September works until 23:59:59.999 on
 * 30 September, Africa/Cairo — not the end of 30 September on whatever clock the
 * admin's laptop happens to use, which is what the date picker produced before.
 *
 * Egypt observes daylight saving time again (since 2023), so the offset is not
 * a constant: +03:00 in summer, +02:00 in winter. It is read from the runtime's
 * time zone data for the date in question rather than hard-coded.
 *
 * Pure, no dependencies, used by the dashboard and by the server's overview
 * figures, so this is the only place the rule lives.
 */

export const SHOP_TIME_ZONE = "Africa/Cairo";

const FIELDS = { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" };

/** Minutes the shop's clock is ahead of UTC at this instant. */
function offsetMinutes(instantMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TIME_ZONE, hourCycle: "h23", ...FIELDS })
    .formatToParts(new Date(instantMs));
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));
  return Math.round((wall - Math.floor(instantMs / 1000) * 1000) / 60000);
}

/**
 * `YYYY-MM-DD` as the last millisecond of that day in Cairo, as an ISO string,
 * or null when it is not a real calendar date.
 */
export function endOfShopDay(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? "").trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;

  const wall = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  // Twice: the offset at the first guess can differ from the offset at the real
  // instant when a clock change falls between the two.
  let instant = wall - offsetMinutes(wall) * 60000;
  instant = wall - offsetMinutes(instant) * 60000;
  return new Date(instant).toISOString();
}

/**
 * The last `days` Cairo calendar days, today included, oldest first, and the
 * instant the first of them began. What the dashboard's daily figures count in:
 * bucketed by UTC day, an order placed just after midnight in Cairo was filed
 * under the day before.
 */
export function shopDays(days, nowMs = Date.now()) {
  const [year, month, day] = shopDateOf(new Date(nowMs).toISOString()).split("-").map(Number);
  const dateAt = (offset) => new Date(Date.UTC(year, month - 1, day - offset)).toISOString().slice(0, 10);
  const dates = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) dates.push(dateAt(offset));
  const start = new Date(Date.parse(endOfShopDay(dateAt(days))) + 1).toISOString();
  return { dates, start };
}

/** The Cairo calendar day an instant falls on, as `YYYY-MM-DD`, or "" for nonsense. */
export function shopDateOf(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}
