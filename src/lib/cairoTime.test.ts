import { describe, expect, it } from "vitest";
import { endOfShopDay, shopDateOf } from "../../shared/cairoTime.mjs";

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
});
