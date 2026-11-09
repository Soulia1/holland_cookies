import { describe, expect, it } from "vitest";
import { MENU_GROUPS } from "../data/menu";
import type { ApiProduct } from "./api";
import { leadDaysForProduct, withLiveCatalogue, type LiveMenu } from "./liveMenu";

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

  it("shows none when the database never had a list, whatever the printed sheet says", () => {
    expect(scoop.choices?.length).toBeGreaterThan(0);
    expect(shown({}).choices).toBeUndefined();
  });
});

/*
 * What the cart is able to say about a line.
 *
 * The cart knows a product id and nothing else, so this is the whole path from
 * that id to "two working days": product → its category → the page that
 * category is on → the page's lead time. Read live rather than snapshotted when
 * the line was added, so a cart that has sat in storage since before the shop
 * set a lead time does not promise the old answer.
 */
describe("leadDaysForProduct", () => {
  const specials = MENU_GROUPS.find((group) => group.id === "special-edition")!;
  const [specialCategory] = specials.categories;

  it("answers two working days for something on the Special Edition page", () => {
    const catalogue = live([product("p1", specialCategory.id)], [specialCategory.id]);
    expect(leadDaysForProduct(catalogue, "p1")).toBe(2);
  });

  it("answers nothing for an everyday item", () => {
    const catalogue = live([product("p2", pans.id)], [pans.id]);
    expect(leadDaysForProduct(catalogue, "p2")).toBe(0);
  });

  it("follows a dashboard-made category to the page it names", () => {
    const catalogue: LiveMenu = {
      products: new Map([["p3", product("p3", "limited-drop")]]),
      categories: new Map([["limited-drop", { name: "Limited Drop", group: "special-edition" }]]),
    };
    expect(leadDaysForProduct(catalogue, "p3")).toBe(2);
  });

  it("says nothing it cannot know", () => {
    const catalogue = live([product("p4", pans.id)], [pans.id]);
    // A line for a product the catalogue no longer has: the checkout tells the
    // customer it is gone, and inventing a lead time for it helps nobody.
    expect(leadDaysForProduct(catalogue, "vanished")).toBe(0);
    expect(leadDaysForProduct(null, "p4")).toBe(0);
  });
});

describe("admin catalogue changes", () => {
  it("moves a printed product without leaving a duplicate in its old category", () => {
    const first = pans.items[0];
    const catalogue = live([product(first.id, "seasonal")], [pans.id, "seasonal"]);
    const shown = withLiveCatalogue(cookies, catalogue);
    expect(shown.categories.map((category) => category.id)).toEqual(["seasonal"]);
    expect(shown.categories.flatMap((category) => category.items).map((item) => item.id)).toEqual([first.id]);
  });
  it("respects API product order even for printed products", () => {
    const [first, second] = pans.items;
    const shown = withLiveCatalogue(cookies, live([product(second.id, pans.id), product(first.id, pans.id)], [pans.id]));
    expect(shown.categories[0].items.map((item) => item.id)).toEqual([second.id, first.id]);
  });
  it("respects API category order instead of the printed order", () => {
    const [first, second] = cookies.categories;
    const shown = withLiveCatalogue(cookies, live([product(first.items[0].id, first.id), product(second.items[0].id, second.id)], [second.id, first.id]));
    expect(shown.categories.map((category) => category.id)).toEqual([second.id, first.id]);
  });
  it("does not restore notes or Arabic names the admin cleared", () => {
    const printed = cookies.categories.flatMap((category) => category.items).find((item) => item.note)!;
    const category = cookies.categories.find((category) => category.items.includes(printed))!;
    const shown = withLiveCatalogue(cookies, live([product(printed.id, category.id, { note: "", nameAr: "", noteAr: "" })], [category.id]));
    expect(shown.categories[0].items[0]).toMatchObject({ note: undefined, nameAr: undefined, noteAr: undefined });
  });
  it("carries both sale and regular prices and restores the regular price after disabling a sale", () => {
    const first = pans.items[0];
    const show = (extra: Partial<ApiProduct>) => withLiveCatalogue(cookies, live([product(first.id, pans.id, extra)], [pans.id])).categories[0].items[0];
    expect(show({ price: 90, regularPrice: 100, discounted: true })).toMatchObject({ price: 90, regularPrice: 100, discounted: true });
    expect(show({ price: 100, regularPrice: 100, discounted: false })).toMatchObject({ price: 100, discounted: false });
  });
});
