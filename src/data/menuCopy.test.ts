import { describe, expect, it } from "vitest";
import { MENU, type MenuCategory } from "./menu";
import { describeItem } from "./menuCopy";

const cups = MENU.find((category) => category.id === "cookie-cups") as MenuCategory;

describe("describeItem", () => {
  it("lower-cases the sentence but keeps brand names as printed", () => {
    expect(describeItem({ id: "x", name: "Vanilla, Nutella filling", price: 1 }, cups))
      .toBe("A cookie cup — vanilla, Nutella filling.");
  });

  it("keeps a number in a name, including one that looks like a placeholder", () => {
    // A name edited in the dashboard can say anything. Brand names are masked
    // by index between NUL characters, so a bare number must survive unmasked.
    expect(describeItem({ id: "x", name: "Box of 6 Lotus pieces", price: 1 }, cups))
      .toBe("A cookie cup — box of 6 Lotus pieces.");
    expect(describeItem({ id: "x", name: "Kinder 0 sugar", price: 1 }, cups))
      .toBe("A cookie cup — Kinder 0 sugar.");
  });

  it("never prints undefined for any printed item", () => {
    for (const category of MENU) {
      for (const item of category.items) {
        expect(describeItem(item, category)).not.toContain("undefined");
      }
    }
  });
});
