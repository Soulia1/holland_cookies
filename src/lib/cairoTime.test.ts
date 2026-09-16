import { describe, expect, it } from "vitest";
import { endOfShopDay, shopDateOf, shopDays } from "../../shared/cairoTime.mjs";

/**
 * Promo expiry is a day in Cairo. These pin the rule to real instants on both
 * sides of Egypt's daylight saving change, so a regression to "the operator's
 * own time zone" or to a fixed +02:00 fails here rather than at a customer.
 */
describe("the shop's calendar", () => {
  it("ends a summer day at midnight Cairo summer time (UTC+3)", () => {
    expect(endOfShopDay("2026-09-30")).toBe("2026-09-30T20:59:59.999Z");
  });

  it("ends a winter day at midnight Cairo standard time (UTC+2)", () => {
    expect(endOfShopDay("2026-12-31")).toBe("2026-12-31T21:59:59.999Z");
  });

  it("refuses what is not a real calendar date", () => {
    for (const bad of ["", "2026-02-30", "2026-13-01", "30/09/2026", "tomorrow"]) {
      expect(endOfShopDay(bad)).toBeNull();
    }
  });

  it("reads a stored expiry back as the Cairo day it ends on", () => {
    expect(shopDateOf("2026-09-30T20:59:59.999Z")).toBe("2026-09-30");
    expect(shopDateOf("2026-12-31T21:59:59.999Z")).toBe("2026-12-31");
    // 23:30 UTC on the 30th is already the 1st in Cairo.
    expect(shopDateOf("2026-09-30T23:30:00.000Z")).toBe("2026-10-01");
    expect(shopDateOf("nonsense")).toBe("");
  });

  it("counts the dashboard's days in Cairo, not UTC", () => {
    // 22:30 UTC on the 15th is 01:30 on the 16th in Cairo (summer, UTC+3).
    const now = Date.parse("2026-09-15T22:30:00.000Z");
    expect(shopDays(2, now)).toEqual({
      dates: ["2026-09-15", "2026-09-16"],
      start: "2026-09-14T21:00:00.000Z",
    });
  });

  it("starts a window that spans the clock change at the right offset", () => {
    // Egypt leaves summer time on the last Thursday of October (2026-10-29).
    const now = Date.parse("2026-11-01T12:00:00.000Z");
    const { dates, start } = shopDays(5, now);
    expect(dates).toEqual(["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(start).toBe("2026-10-27T21:00:00.000Z");
  });
});
