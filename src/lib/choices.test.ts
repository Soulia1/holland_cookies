import { describe, expect, it } from "vitest";
import { choiceProblem, lineSignature } from "../../shared/productPricing.mjs";
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
