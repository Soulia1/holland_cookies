import { describe, expect, it } from "vitest";
import {
  MAX_QTY,
  addItem,
  cartCount,
  cartSubtotal,
  changeQty,
  clearCart,
  lineKey,
  loadCart,
  type CartItem,
} from "./cart-core";
import { removeItem } from "./cart-core";

const vanilla = { productId: "plain-vanilla", name: "Vanilla", price: 50 };
const lotus = { productId: "plain-lotus", name: "Lotus", price: 60 };

describe("lineKey", () => {
  it("is the product id, so the same product is always one line", () => {
    expect(lineKey(vanilla)).toBe("plain-vanilla");
  });
});

describe("addItem", () => {
  it("adds a new line", () => {
    const items = addItem([], vanilla);
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(1);
  });

  it("merges a repeat add into the existing line rather than duplicating it", () => {
    const items = addItem(addItem([], vanilla), vanilla);
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(2);
  });

  it("keeps distinct products on separate lines", () => {
    const items = addItem(addItem([], vanilla), lotus);
    expect(items).toHaveLength(2);
  });

  it("refreshes the display snapshot when a repeat add carries a new price", () => {
    const items = addItem(addItem([], vanilla), { ...vanilla, price: 55 });
    expect(items[0].price).toBe(55);
    expect(items[0].qty).toBe(2);
  });

  it("caps a line at MAX_QTY rather than growing without limit", () => {
    const items = addItem([], vanilla, MAX_QTY + 10);
    expect(items[0].qty).toBe(MAX_QTY);
  });

  it("does not mutate the array it was given", () => {
    const before: CartItem[] = [];
    addItem(before, vanilla);
    expect(before).toHaveLength(0);
  });
});

describe("changeQty", () => {
  it("increases and decreases", () => {
    const items = changeQty(addItem([], vanilla, 3), "plain-vanilla", -1);
    expect(items[0].qty).toBe(2);
  });

  it("drops the line when the quantity reaches zero", () => {
    expect(changeQty(addItem([], vanilla), "plain-vanilla", -1)).toHaveLength(0);
  });

  it("will not exceed MAX_QTY", () => {
    const items = changeQty(addItem([], vanilla, MAX_QTY), "plain-vanilla", 1);
    expect(items[0].qty).toBe(MAX_QTY);
  });

  it("ignores an unknown key", () => {
    const items = addItem([], vanilla);
    expect(changeQty(items, "nope", 1)).toEqual(items);
  });
});

describe("removeItem / clearCart", () => {
  it("removes one line and leaves the rest", () => {
    const items = removeItem(addItem(addItem([], vanilla), lotus), "plain-vanilla");
    expect(items).toHaveLength(1);
    expect(items[0].productId).toBe("plain-lotus");
  });

  it("empties everything", () => {
    expect(clearCart()).toEqual([]);
  });
});

describe("totals", () => {
  const items = addItem(addItem([], vanilla, 2), lotus, 3);

  it("counts pieces, not lines", () => {
    expect(cartCount(items)).toBe(5);
  });

  it("sums line totals", () => {
    expect(cartSubtotal(items)).toBe(2 * 50 + 3 * 60);
  });

  it("rounds to two decimals rather than accumulating float dust", () => {
    const odd = addItem([], { productId: "x", name: "X", price: 0.1 }, 3);
    expect(cartSubtotal(odd)).toBe(0.3);
  });
});

describe("loadCart", () => {
  it("returns an empty cart for absent, malformed or non-array storage", () => {
    expect(loadCart(null)).toEqual([]);
    expect(loadCart("not json")).toEqual([]);
    expect(loadCart('{"productId":"x"}')).toEqual([]);
  });

  it("drops entries that are not usable cart lines", () => {
    const raw = JSON.stringify([
      { productId: "plain-vanilla", name: "Vanilla", price: 50, qty: 2 },
      { productId: "", name: "Nameless", price: 10, qty: 1 },
      { productId: "bad-price", name: "Bad", price: "50", qty: 1 },
      { productId: "bad-qty", name: "Bad", price: 50, qty: 0 },
      null,
    ]);
    const items = loadCart(raw);
    expect(items).toHaveLength(1);
    expect(items[0].productId).toBe("plain-vanilla");
  });

  it("clamps a tampered quantity", () => {
    const raw = JSON.stringify([{ productId: "x", name: "X", price: 5, qty: 9999 }]);
    expect(loadCart(raw)[0].qty).toBe(MAX_QTY);
  });
});
