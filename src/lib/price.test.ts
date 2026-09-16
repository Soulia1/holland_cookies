import { describe, expect, it } from "vitest";
import { __dictionaries } from "./i18n";
import { effectivePrice } from "../../shared/productPricing.mjs";

describe("price", () => {
  it("prints whole pounds with the house .00", () => {
    expect(__dictionaries.en.price(150)).toBe("150.00 EGP");
    expect(__dictionaries.ar.price(150)).toBe("150.00 ج.م");
  });

  it("prints a discounted price in piastres once, not glued to .00", () => {
    // 10% off 85 is 76.5: a percentage discount the dashboard allows.
    const sale = effectivePrice({ price: 85, discountEnabled: true, discountType: "percent", discountValue: 10 });
    expect(__dictionaries.en.price(sale)).toBe("76.50 EGP");
    expect(__dictionaries.ar.price(sale)).toBe("76.50 ج.م");
    expect(__dictionaries.en.price(72.25)).toBe("72.25 EGP");
  });

  it("rounds float dust from a sum to piastres", () => {
    expect(__dictionaries.en.price(0.1 + 0.2)).toBe("0.30 EGP");
  });
});
