import { describe, expect, it } from "vitest";
import { MENU_GROUPS, flavorVariants } from "../data/menu";
import type { ApiProduct } from "./api";
import { withLiveCatalogue, type LiveMenu } from "./liveMenu";

const cookies = MENU_GROUPS.find((group) => group.id === "cookies")!;
const [pans] = cookies.categories;

function product(id: string, categoryId: string, extra: Partial<ApiProduct> = {}): ApiProduct {
  return {
    id,
    categoryId,
    name: `DB ${id}`,
    price: 999,
    regularPrice: 999,
    discounted: false,
    available: true,
    ...extra,
  };
}

function live(products: ApiProduct[], categoryIds: string[]): LiveMenu {
  return {
    products: new Map(products.map((p) => [p.id, p])),
    categories: new Map(categoryIds.map((id) => [id, { name: "" }])),
  };
}

describe("withLiveCatalogue", () => {
  it("shows the printed menu untouched until the catalogue arrives", () => {
    expect(withLiveCatalogue(cookies, null)).toBe(cookies);
  });

  it("applies the database's name, price, photo and availability", () => {
    const first = pans.items[0];
    const catalogue = live(
      [product(first.id, pans.id, { price: 175, image: "/img/x.webp", available: false })],
      [pans.id],
    );
    const [category] = withLiveCatalogue(cookies, catalogue).categories;
    expect(category.items).toHaveLength(1);
    expect(category.items[0]).toMatchObject({
      id: first.id,
      name: `DB ${first.id}`,
      price: 175,
      image: "/img/x.webp",
      soldOut: true,
    });
  });

  it("drops hidden categories and deleted products, and adds dashboard-created ones", () => {
    const catalogue = live(
      [
        product(pans.items[0].id, pans.id),
        product("new-thing", pans.id),
        product("scoop-nutella-foil--vanilla", pans.id),
      ],
      [pans.id],
    );
    const shown = withLiveCatalogue(cookies, catalogue);
    expect(shown.categories.map((c) => c.id)).toEqual([pans.id]);
    expect(shown.categories[0].items.map((i) => i.id)).toEqual([pans.items[0].id, "new-thing"]);
  });
});

describe("flavorVariants", () => {
  it("gives each flavor of a printed line its own product id and name", () => {
    const scoop = cookies.categories.flatMap((c) => c.items).find((i) => i.flavorChoices)!;
    const variants = flavorVariants(scoop);
    expect(variants.map((v) => v.id)).toEqual([
      "scoop-nutella-foil--vanilla",
      "scoop-nutella-foil--red-velvet",
      "scoop-nutella-foil--chocolate",
    ]);
    expect(variants[1].name).toBe("Red Velvet, Nutella filling");
  });
});
