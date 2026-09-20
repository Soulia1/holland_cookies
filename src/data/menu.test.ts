import { describe, expect, it } from "vitest";
import {
  CATEGORY_BY_ID,
  GROUP_BY_CATEGORY_ID,
  GROUP_BY_ID,
  ITEM_COUNT,
  MENU,
  MENU_GROUPS,
  groupItemCount,
  groupPriceFrom,
  itemPriceFrom,
  itemPriceVaries,
  priceFrom,
} from "./menu";

/*
 * The menu is static data, so most of it needs no test — a wrong price is a
 * wrong price whatever is asserted about it. What does need one is the *shape*
 * introduced when the seventeen printed categories were folded into three
 * groups, because that shape is a second description of the same data and the
 * two can silently disagree.
 *
 * The failure being guarded against is specific and quiet: a category that no
 * group claims does not throw, does not warn, and does not look broken. It just
 * stops being reachable. Its page is gone, its items are unbuyable, and the only
 * symptom is a page slightly shorter than it should be. Nobody notices that by
 * looking, which is exactly what a test is for.
 *
 * The other direction — a group naming a category that does not exist — throws
 * at import time in menu.ts and needs nothing here.
 */

describe("menu groups", () => {
  it("claim every category, exactly once between them", () => {
    const claimed = MENU_GROUPS.flatMap((group) => group.categories.map((c) => c.id));

    // Sorted, because group order is a display decision — the cookies run
    // together where the sheets print a brownie in the middle of them — and
    // this is asserting membership, not sequence.
    expect([...claimed].sort()).toEqual(MENU.map((c) => c.id).sort());
    // Which also catches the case the comparison above would let through if a
    // category were claimed twice *and* another dropped.
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it("hold the same items the flat menu does, none added or lost", () => {
    const total = MENU_GROUPS.reduce((sum, group) => sum + groupItemCount(group), 0);
    expect(total).toBe(ITEM_COUNT);
  });

  it("index every group and every category by id", () => {
    for (const group of MENU_GROUPS) {
      expect(GROUP_BY_ID.get(group.id)).toBe(group);
      for (const category of group.categories) {
        // The lookup the router uses to keep an old `/menu/cookie-pans` link
        // working: every category id still resolves to somewhere real.
        expect(GROUP_BY_CATEGORY_ID.get(category.id)).toBe(group);
        expect(CATEGORY_BY_ID.get(category.id)).toBe(category);
      }
    }
    expect(GROUP_BY_CATEGORY_ID.size).toBe(MENU.length);
  });

  it("never share an id between a group and a category", () => {
    // Both live in the same path segment — `/menu/cookies` and
    // `/menu/cookie-pans` — and the router tries the group first. A collision
    // would make one of the two unreachable, and the one it hid would be a
    // category, whose links are the ones already in the wild.
    for (const group of MENU_GROUPS) {
      expect(CATEGORY_BY_ID.has(group.id), `"${group.id}" is both a group and a category`).toBe(
        false,
      );
    }
  });

  it("carry a name in both languages", () => {
    for (const group of MENU_GROUPS) {
      expect(group.name.trim()).not.toBe("");
      expect(group.nameAr.trim()).not.toBe("");
      // The same check `i18n.test.ts` makes of the dictionary: an Arabic label
      // that is still Latin script is a missing translation wearing a value.
      expect(group.nameAr, `${group.id} has no Arabic name`).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it("price a group from the cheapest thing anywhere in it", () => {
    for (const group of MENU_GROUPS) {
      const cheapest = Math.min(...group.categories.map(priceFrom));
      expect(groupPriceFrom(group)).toBe(cheapest);
      // And it is a real price, not the Infinity an empty group would give.
      expect(Number.isFinite(groupPriceFrom(group))).toBe(true);
    }
  });
});

/*
 * A price on a row has to be a price the shop will actually take. An item whose
 * options all cost extra cannot be bought at the figure in its own `price`
 * field, and printing that figure is advertising a price that does not exist.
 */
describe("the price on a row", () => {
  it("is the item's own price when it has no options", () => {
    expect(itemPriceFrom({ id: "x", name: "X", price: 150 })).toBe(150);
    expect(itemPriceVaries({ id: "x", name: "X", price: 150 })).toBe(false);
  });

  it("is the item plus its cheapest option", () => {
    const item = {
      id: "x",
      name: "X",
      price: 180,
      choices: [{ name: "Large", priceDelta: 60 }, { name: "Huge", priceDelta: 120 }],
    };
    expect(itemPriceFrom(item)).toBe(240);
    // Two different extras, so the row says "from".
    expect(itemPriceVaries(item)).toBe(true);
  });

  it("does not say “from” when every option costs the same", () => {
    const item = {
      id: "x",
      name: "X",
      price: 180,
      choices: [{ name: "Vanilla" }, { name: "Chocolate" }],
    };
    expect(itemPriceFrom(item)).toBe(180);
    expect(itemPriceVaries(item)).toBe(false);
  });

  it("prices a category from the cheapest row as a customer could order it", () => {
    const specials = CATEGORY_BY_ID.get("special-edition-cookies");
    expect(specials).toBeDefined();
    expect(priceFrom(specials!)).toBe(Math.min(...specials!.items.map(itemPriceFrom)));
  });
});
