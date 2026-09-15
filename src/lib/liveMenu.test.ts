import { describe, expect, it } from "vitest";
import { MENU_GROUPS } from "../data/menu";
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

describe("dashboard-created categories", () => {
  const desserts = MENU_GROUPS.find((group) => group.id === "desserts")!;
  const catalogue: LiveMenu = {
    products: new Map([
      ["pistachio-cookie", product("pistachio-cookie", "seasonal", { description: "Fresh", descriptionAr: "طازج" })],
      ["loose-item", product("loose-item", "loose")],
    ]),
    categories: new Map([
      [pans.id, { name: "" }],
      ["seasonal", { name: "Seasonal", nameAr: "موسمي", group: "desserts" }],
      ["loose", { name: "Loose" }],
      ["empty", { name: "Empty", group: "desserts" }],
    ]),
  };
  const ids = (group: typeof cookies) => withLiveCatalogue(group, catalogue).categories.map((c) => c.id);

  it("shows one on the page it was filed under, and on no other", () => {
    expect(ids(desserts)).toContain("seasonal");
    expect(ids(cookies)).not.toContain("seasonal");
  });

  it("carries the category's names and the product's own description", () => {
    const seasonal = withLiveCatalogue(desserts, catalogue).categories.find((c) => c.id === "seasonal")!;
    expect(seasonal).toMatchObject({ name: "Seasonal", nameAr: "موسمي" });
    expect(seasonal.items).toHaveLength(1);
    expect(seasonal.items[0]).toMatchObject({
      id: "pistachio-cookie", name: "DB pistachio-cookie", description: "Fresh", descriptionAr: "طازج",
    });
  });

  it("puts one with no section on the first page rather than nowhere", () => {
    expect(ids(cookies)).toContain("loose");
    expect(ids(desserts)).not.toContain("loose");
  });

  it("leaves out a category with nothing in it", () => {
    expect(ids(desserts)).not.toContain("empty");
  });
});

describe("options", () => {
  const scoop = cookies.categories.flatMap((c) => c.items).find((i) => i.choices)!;
  const scoops = cookies.categories.find((c) => c.items.includes(scoop))!;
  const shown = (extra: Partial<ApiProduct>) =>
    withLiveCatalogue(cookies, live([product(scoop.id, scoops.id, extra)], [scoops.id]))
      .categories[0].items[0];

  it("shows the options the dashboard saved, not the printed ones", () => {
    expect(shown({ choices: [{ name: "Lotus" }] }).choices).toEqual([{ name: "Lotus" }]);
  });

  it("shows none once the dashboard has emptied the list", () => {
    expect(shown({ choices: [] }).choices).toBeUndefined();
  });
});
