import { describe, expect, it } from "vitest";
import {
  choiceProblem, choiceSurcharge, lineSignature, lineTotal, unitPrice,
} from "../../shared/productPricing.mjs";
import { addItem, lineKey, loadCart } from "./cart-core";

const scoop = { choices: [{ name: "Vanilla, Nutella filling" }, { name: "Chocolate, Nutella filling" }] };
const line = { productId: "scoop", name: "Cookie scoops", price: 300 };

describe("choiceProblem", () => {
  it("needs exactly one of the stored options", () => {
    expect(choiceProblem(scoop, "Vanilla, Nutella filling")).toBeNull();
    expect(choiceProblem(scoop, undefined)).toBe("Choose an option for this item.");
    expect(choiceProblem(scoop, "Lotus")).toBe("That option is no longer offered.");
  });

  it("takes no option on a product that has none", () => {
    expect(choiceProblem({ choices: [] }, undefined)).toBeNull();
    expect(choiceProblem({}, "Vanilla")).toBe("This item has no options to choose from.");
  });
});

describe("a cart line with an option", () => {
  it("is a separate line for each option", () => {
    expect(lineSignature({ productId: "scoop", choice: "Vanilla" }))
      .not.toBe(lineSignature({ productId: "scoop", choice: "Lotus" }));
    const items = addItem(addItem([], { ...line, choice: "Vanilla" }), { ...line, choice: "Lotus" });
    expect(items).toHaveLength(2);
    expect(lineKey(items[0])).toBe("scoop#Vanilla");
  });

  it("merges a repeat add of the same option", () => {
    const items = addItem(addItem([], { ...line, choice: "Vanilla" }), { ...line, choice: "Vanilla" });
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(2);
  });

  it("keeps its option through storage, and drops a malformed one", () => {
    const [kept] = loadCart(JSON.stringify([{ ...line, qty: 1, choice: "Vanilla", choiceLabel: "فانيليا" }]));
    expect(kept).toMatchObject({ choice: "Vanilla", choiceLabel: "فانيليا" });
    expect(loadCart(JSON.stringify([{ ...line, qty: 1, choice: 7 }]))).toEqual([]);
  });
});

/*
 * Options that change the price.
 *
 * The figure comes off the stored product and nowhere else. The cart carries a
 * display snapshot and the server re-prices every line from the catalogue, so
 * an option's extra invented in a browser has to buy nothing.
 */
const sized = {
  price: 180,
  choices: [
    { name: "Regular", priceDelta: 0 },
    { name: "Large", priceDelta: 60 },
  ],
};

describe("an option that costs extra", () => {
  it("adds its own extra to the price, and nothing for an option with none", () => {
    expect(unitPrice(sized, undefined, "Regular")).toBe(180);
    expect(unitPrice(sized, undefined, "Large")).toBe(240);
  });

  it("prices the product alone when no option is named", () => {
    expect(unitPrice(sized, undefined, undefined)).toBe(180);
    expect(unitPrice({ price: 180 }, undefined, "Large")).toBe(180);
  });

  it("charges nothing for an option the product no longer offers", () => {
    // The order is refused by choiceProblem rather than priced at a guess.
    expect(unitPrice(sized, undefined, "Family")).toBe(180);
    expect(choiceProblem(sized, "Family")).toBe("That option is no longer offered.");
  });

  it("ignores a negative or unusable extra rather than discounting the item", () => {
    expect(choiceSurcharge({ choices: [{ name: "A", priceDelta: -50 }] }, "A")).toBe(0);
    // Not a number at all: a document written before this field existed, or by
    // hand. Typed as unknown here because no caller could ever type it.
    expect(choiceSurcharge({ choices: [{ name: "A", priceDelta: "x" as unknown as number }] }, "A"))
      .toBe(0);
  });

  it("multiplies by the quantity", () => {
    expect(lineTotal(sized, 3, undefined, "Large")).toBe(720);
  });

  it("follows a discount on the product, which applies to the item and not to the extra", () => {
    const halfPrice = {
      ...sized, discountEnabled: true, discountType: "percent" as const, discountValue: 50,
    };
    expect(unitPrice(halfPrice, undefined, "Large")).toBe(150);
  });
});
