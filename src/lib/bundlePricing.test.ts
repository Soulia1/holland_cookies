import { describe, expect, it } from "vitest";
import { lineSignature, selectionProblem, unitPrice } from "../../shared/productPricing.mjs";
import { addItem, lineKey, loadCart } from "./cart-core";

const bundle = {
  price: 100,
  isBundle: true,
  bundleType: "choice" as const,
  groups: [
    {
      label: "Cookies",
      choose: 2,
      allowRepeats: false,
      options: [
        { productId: "vanilla", surcharge: 0 },
        { productId: "lotus", surcharge: 15 },
      ],
    },
  ],
};

describe("bundle pricing", () => {
  it("adds each pick's surcharge to the bundle price", () => {
    expect(unitPrice(bundle, [
      { group: 0, productId: "vanilla", quantity: 1 },
      { group: 0, productId: "lotus", quantity: 1 },
    ])).toBe(115);
  });

  it("needs exactly the number of picks each choice asks for", () => {
    expect(selectionProblem(bundle, [{ group: 0, productId: "vanilla", quantity: 1 }]))
      .toBe("Choose 2 for “Cookies”.");
    expect(selectionProblem(bundle, [
      { group: 0, productId: "vanilla", quantity: 1 },
      { group: 0, productId: "lotus", quantity: 1 },
    ])).toBeNull();
  });

  it("refuses a repeat where repeats are not allowed, and an option not offered", () => {
    expect(selectionProblem(bundle, [{ group: 0, productId: "vanilla", quantity: 2 }]))
      .toBe("“Cookies” cannot have the same one twice.");
    expect(selectionProblem(bundle, [{ group: 0, productId: "pistachio", quantity: 2 }]))
      .toBe("One of your choices is no longer offered.");
  });

  it("refuses choices on a product that takes none", () => {
    expect(selectionProblem({ price: 50 }, [{ group: 0, productId: "x", quantity: 1 }]))
      .toBe("This item has no choices to make.");
    expect(selectionProblem({ price: 50 }, [])).toBeNull();
  });

  it("identifies a line by its picks, in any order", () => {
    const a = lineSignature({ productId: "box", selections: [
      { group: 0, productId: "vanilla", quantity: 1 },
      { group: 0, productId: "lotus", quantity: 1 },
    ] });
    const b = lineSignature({ productId: "box", selections: [
      { group: 0, productId: "lotus", quantity: 1 },
      { group: 0, productId: "vanilla", quantity: 1 },
    ] });
    expect(a).toBe(b);
    expect(lineSignature({ productId: "plain" })).toBe("plain");
  });
});

describe("cart lines for bundles", () => {
  const pick = (productId: string) => ({ group: 0, productId, quantity: 2, name: productId });

  it("keeps a bundle with different picks as a separate line", () => {
    let cart = addItem([], { productId: "box", name: "Box", price: 100, selections: [pick("vanilla")] });
    cart = addItem(cart, { productId: "box", name: "Box", price: 130, selections: [pick("lotus")] });
    cart = addItem(cart, { productId: "box", name: "Box", price: 100, selections: [pick("vanilla")] });
    expect(cart).toHaveLength(2);
    expect(cart[0].qty).toBe(2);
    expect(lineKey(cart[0])).not.toBe(lineKey(cart[1]));
  });

  it("restores picks from storage and drops a malformed one", () => {
    const stored = JSON.stringify([
      { productId: "box", name: "Box", price: 100, qty: 1, selections: [pick("vanilla")] },
      { productId: "box", name: "Box", price: 100, qty: 1, selections: [{ group: "x" }] },
    ]);
    const cart = loadCart(stored);
    expect(cart).toHaveLength(1);
    expect(cart[0].selections).toEqual([pick("vanilla")]);
  });
});
