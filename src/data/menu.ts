/**
 * The full menu, as plain data.
 *
 * Transcribed from the three printed menu sheets and translated into English.
 * The sheets are the source of truth; this module is the only place their
 * contents live, and `/menu` is the only page that renders them.
 *
 * Two rules held throughout the translation:
 *
 * 1. **Nothing was invented.** The sheets carry a name and a price per item and
 *    nothing else — no descriptions, no ingredient lists, no sizes beyond what
 *    is printed. So there are no descriptions here either. A menu that says
 *    "Vanilla, Nutella-filled" is transcribing; one that says "our signature
 *    vanilla dough, slow-folded overnight" is making things up about someone
 *    else's food. Where the printed name is a proper product name — Despacito,
 *    Matilda, Happiness — it is kept as a name rather than translated into a
 *    literal English word that would mean nothing on a menu.
 *
 * 2. **Ids are stable and independent of the display text.** Every id is a
 *    slug fixed at transcription time. Rewording an item in English must never
 *    change its id, because ids are what anything downstream — a cart line, an
 *    order record, a deep link — would key on.
 *
 * `note` carries packaging or format that is part of the printed item ("foil
 * tray", "kraft box", "14 inch") and would otherwise be lost.
 */

export interface MenuItem {
  /** Stable. Never derived from the display name at runtime. */
  id: string;
  name: string;
  /**
   * The Arabic name, where it has been transcribed.
   *
   * Optional on purpose, and the optionality is the design rather than an
   * unfinished edge. The printed sheets are the source for these and they are
   * transcribed, never invented — the same rule the English names were held to
   * (see the header). Until an item's Arabic is read off a sheet the field is
   * absent, and `localized()` falls back to the English name inside the Arabic
   * page. A customer reading a familiar English product name in an otherwise
   * Arabic menu is a small blemish; a machine-translated name for someone
   * else's food is a lie about their product.
   *
   * This is also the exact shape Scooby stores per product (`nameAr`), so when
   * the menu moves into a database the schema and the admin editor port across
   * without a migration.
   */
  nameAr?: string;
  price: number;
  /** Printed packaging or size, where the sheet gives one. */
  note?: string;
  noteAr?: string;
}

export interface MenuCategory {
  /** Stable, and the anchor target: `/menu#cookie-pans`. */
  id: string;
  /** English display name. */
  name: string;
  /**
   * Arabic display name.
   *
   * Deliberately not the same field as `original`, which is easy to assume it
   * could be. `original` means "as printed", and four of the sheets' category
   * headings are printed in English — `Coffees`, `Iced Coffee`, `Frappes`,
   * `Milkshakes`. Reusing it as the Arabic name would have rendered those four
   * headings in Latin script in the middle of an Arabic page.
   */
  nameAr: string;
  /** The name as printed, kept so the sheets can be checked against this file. */
  original: string;
  items: MenuItem[];
}

/** Every price on all three sheets is in Egyptian pounds. */
export const CURRENCY = "EGP";

export const MENU: MenuCategory[] = [
  {
    id: "plain-cookies",
    name: "Plain Cookies",
    nameAr: "كوكيز سادة",
    original: "كوكيز سادة",
    items: [
      { id: "plain-vanilla", name: "Vanilla", price: 50 },
      { id: "plain-chocolate", name: "Chocolate", price: 50 },
      { id: "plain-pistachio", name: "Pistachio", price: 60 },
      { id: "plain-red-velvet", name: "Red Velvet", price: 60 },
      { id: "plain-lotus", name: "Lotus", price: 60 },
      { id: "plain-coffee", name: "Coffee", price: 60 },
    ],
  },
  {
    id: "cookie-pans",
    name: "Cookie Pans",
    nameAr: "كوكي بان",
    original: "كوكي بان",
    items: [
      { id: "pan-vanilla-nutella", name: "Vanilla, Nutella filling", price: 150 },
      { id: "pan-vanilla-bueno", name: "Vanilla, Kinder Bueno filling", price: 150 },
      { id: "pan-chocolate-nutella", name: "Chocolate, Nutella filling", price: 150 },
      { id: "pan-chocolate-bueno", name: "Chocolate, Kinder Bueno filling", price: 150 },
      {
        id: "pan-red-velvet-white-nutella",
        name: "Red Velvet, white Nutella filling",
        price: 150,
      },
      { id: "pan-lotus-smores", name: "Lotus S'mores", price: 180 },
    ],
  },
  {
    id: "cookie-cups",
    name: "Cookie Cups",
    nameAr: "كوكيز كب",
    original: "كوكيز كب",
    items: [
      { id: "cup-vanilla-lotus", name: "Vanilla, Lotus filling", price: 60 },
      { id: "cup-vanilla-nutella", name: "Vanilla, Nutella filling", price: 60 },
      { id: "cup-chocolate-nutella", name: "Chocolate, Nutella filling", price: 60 },
      { id: "cup-chocolate-pistachio", name: "Chocolate, pistachio filling", price: 60 },
      { id: "cup-chocolate-bueno", name: "Chocolate, Kinder Bueno filling", price: 60 },
      { id: "cup-red-velvet-nutella", name: "Red Velvet, Nutella filling", price: 60 },
      {
        id: "cup-red-velvet-white-nutella",
        name: "Red Velvet, white Nutella filling",
        price: 60,
      },
    ],
  },
  {
    id: "cookie-tagines",
    name: "Cookie Tagines",
    nameAr: "طاجن كوكيز",
    original: "طاجن كوكيز",
    items: [
      { id: "tagine-vanilla-nutella", name: "Vanilla, Nutella filling", price: 120 },
      { id: "tagine-chocolate-nutella", name: "Chocolate, Nutella filling", price: 120 },
      {
        id: "tagine-chocolate-white-nutella",
        name: "Chocolate, white Nutella filling",
        price: 120,
      },
      {
        id: "tagine-red-velvet-white-nutella",
        name: "Red Velvet, white Nutella filling",
        price: 120,
      },
      {
        id: "tagine-kunafa-vanilla-small",
        name: "Vanilla Kunafa Cookie",
        price: 120,
        note: "Small",
      },
      {
        id: "tagine-kunafa-chocolate-small",
        name: "Chocolate Kunafa Cookie",
        price: 120,
        note: "Small",
      },
      {
        id: "tagine-vanilla-nutella-coffee",
        name: "Vanilla with coffee, Nutella filling",
        price: 150,
      },
      { id: "tagine-coffee-nutella", name: "Coffee, Nutella filling", price: 150 },
      { id: "tagine-matilda", name: "Matilda Cookie", price: 130 },
      { id: "tagine-red-velvet-crunchy", name: "Red Velvet Crunchy", price: 140 },
    ],
  },
  {
    id: "cookie-scoops",
    name: "Cookie Scoops",
    nameAr: "سكوب كوكيز",
    original: "سكوب كوكيز",
    items: [
      {
        id: "scoop-nutella-foil",
        name: "Vanilla, Red Velvet or Chocolate — Nutella filling",
        price: 300,
        note: "Foil tray",
      },
      {
        id: "scoop-vanilla-bueno-foil",
        name: "Vanilla, Kinder Bueno filling",
        price: 350,
        note: "Foil tray",
      },
      { id: "scoop-mixed-foil", name: "Mixed scoops", price: 380, note: "Foil tray" },
      {
        id: "scoop-half-vanilla-bueno-foil",
        name: "Half Vanilla, half Kinder Bueno",
        price: 350,
        note: "Foil tray",
      },
      {
        id: "scoop-half-vanilla-chocolate-foil",
        name: "Half Vanilla, half Chocolate",
        price: 350,
        note: "Foil tray",
      },
      {
        id: "scoop-vanilla-medium-foil",
        name: "Vanilla",
        price: 450,
        note: "Medium, foil tray",
      },
      {
        id: "scoop-half-vanilla-chocolate-kraft",
        name: "Half Vanilla, half Chocolate",
        price: 450,
        note: "Kraft box",
      },
      {
        id: "scoop-half-vanilla-bueno-kraft",
        name: "Half Vanilla, half Kinder Bueno",
        price: 450,
        note: "Kraft box",
      },
    ],
  },
  {
    id: "cookie-cake",
    name: "Cookie Cake",
    nameAr: "كيكة الكوكيز",
    original: "كيكة الكوكيز",
    items: [
      { id: "cake-vanilla-nutella", name: "Vanilla, Nutella filling", price: 100 },
      { id: "cake-chocolate-bueno", name: "Chocolate, Kinder Bueno filling", price: 100 },
      {
        id: "cake-red-velvet-white-nutella",
        name: "Red Velvet, white Nutella filling",
        price: 100,
      },
      { id: "cake-chocolate-nutella", name: "Chocolate, Nutella filling", price: 100 },
    ],
  },
  {
    id: "brownies-brookies",
    name: "Brownies & Brookies",
    nameAr: "براونيز وبروكيز",
    original: "براونيز + كوكيز",
    items: [
      { id: "brownies", name: "Brownies", price: 100 },
      { id: "classic-brookie", name: "Classic Brookie", price: 100 },
      { id: "red-velvet-brookie", name: "Red Velvet Brookie", price: 100 },
    ],
  },
  {
    id: "cookie-boxes",
    name: "Cookie Boxes",
    nameAr: "بوكسات الكوكيز",
    original: "بوكسات الكوكيز",
    items: [
      { id: "box-cookie-cups", name: "Cookie Cups box", price: 150 },
      { id: "box-plain-cookies", name: "Plain Cookies box", price: 130 },
      { id: "box-mixed-cookies", name: "Mixed Cookies box", price: 300 },
      { id: "box-mini-mixed", name: "Mini Mixed box", price: 210 },
    ],
  },
  {
    id: "tagines",
    name: "Tagines",
    nameAr: "طواجن",
    original: "طواجن",
    items: [
      { id: "happiness-nutella", name: "Happiness — Nutella", price: 120 },
      { id: "happiness-white-nutella", name: "Happiness — white Nutella", price: 120 },
      { id: "happiness-lotus", name: "Happiness — Lotus", price: 130 },
      { id: "happiness-pistachio", name: "Happiness — Pistachio", price: 170 },
      { id: "happiness-kinder-bueno", name: "Happiness — Kinder Bueno", price: 130 },
      { id: "despacito", name: "Despacito", price: 120 },
      { id: "despacito-pistachio", name: "Despacito Pistachio", price: 150 },
      { id: "despacito-bueno", name: "Despacito Kinder Bueno", price: 120 },
      { id: "despacito-chocolate", name: "Despacito Chocolate", price: 120 },
      { id: "despacito-white-nutella", name: "Despacito white Nutella", price: 120 },
    ],
  },
  {
    id: "molten-cakes",
    name: "Molten Cakes",
    nameAr: "مولتن",
    original: "مولتن",
    items: [
      { id: "molten-chocolate", name: "Chocolate", price: 130 },
      { id: "molten-nutella", name: "Nutella", price: 130 },
      { id: "molten-lotus", name: "Lotus", price: 130 },
      { id: "molten-red-velvet", name: "Red Velvet", price: 140 },
    ],
  },
  {
    id: "cheesecakes-tarts",
    name: "Cheesecakes & Tarts",
    nameAr: "قوالب",
    original: "قوالب",
    items: [
      { id: "cheesecake-baked-plain", name: "Baked Plain Cheesecake", price: 120 },
      { id: "cheesecake-pistachio", name: "Pistachio Cheesecake", price: 140, note: "Chilled" },
      { id: "cheesecake-lotus", name: "Lotus Cheesecake", price: 120, note: "Chilled" },
      { id: "cheesecake-raspberry", name: "Raspberry Cheesecake", price: 120, note: "Chilled" },
      { id: "cheesecake-blueberry", name: "Blueberry Cheesecake", price: 120, note: "Chilled" },
      { id: "apple-tart-slice", name: "Apple Tart", price: 120, note: "Per slice" },
    ],
  },
  {
    id: "gateaux",
    name: "Gateaux",
    nameAr: "تورت",
    original: "تورت",
    items: [
      { id: "gateau-lotus-14", name: "Lotus Gateau", price: 450, note: "14 inch" },
      { id: "gateau-pistachio-14", name: "Pistachio Gateau", price: 450, note: "14 inch" },
      { id: "gateau-chocolate-14", name: "Chocolate Gateau", price: 450, note: "14 inch" },
      { id: "gateau-cream-14", name: "Cream Gateau", price: 450, note: "14 inch" },
      { id: "gateau-red-velvet", name: "Red Velvet Gateau", price: 450 },
    ],
  },
  {
    id: "biscuits-kahk",
    name: "Biscuits & Kahk",
    nameAr: "بسكوت وكحك",
    original: "بسكوت وكحك",
    items: [
      { id: "box-kahk", name: "Kahk", price: 150, note: "Box" },
      { id: "box-biscuits-nashader", name: "Nashader Biscuits", price: 150, note: "Box" },
      { id: "box-biscuits-orange", name: "Orange Biscuits", price: 150, note: "Box" },
      { id: "box-biscuits-chocolate", name: "Chocolate Biscuits", price: 150, note: "Box" },
      { id: "box-biscuits-vanilla", name: "Vanilla Biscuits", price: 150, note: "Box" },
      { id: "box-ghorayeba", name: "Ghorayeba", price: 150, note: "Box" },
      { id: "box-petit-fours", name: "Petit Fours", price: 150, note: "Box" },
    ],
  },
  {
    id: "coffee",
    name: "Coffee",
    nameAr: "قهوة",
    original: "Coffees",
    items: [
      { id: "cappuccino", name: "Cappuccino", price: 100 },
      { id: "latte", name: "Latte", price: 90 },
      { id: "mocha", name: "Mocha", price: 90 },
      { id: "cortado", name: "Cortado", price: 90 },
      { id: "hot-chocolate", name: "Hot Chocolate", price: 90 },
      { id: "flat-white", name: "Flat White", price: 90 },
      { id: "espresso", name: "Espresso", price: 90 },
      { id: "turkish-coffee", name: "Turkish Coffee", price: 90 },
      { id: "french-coffee", name: "French Coffee", price: 90 },
      { id: "macchiato", name: "Macchiato", price: 90 },
    ],
  },
  {
    id: "iced-coffee",
    name: "Iced Coffee",
    nameAr: "قهوة مثلجة",
    original: "Iced Coffee",
    items: [
      { id: "iced-coffee", name: "Iced Coffee", price: 100 },
      { id: "iced-mocha", name: "Iced Mocha", price: 100 },
      { id: "iced-caramel-macchiato", name: "Iced Caramel Macchiato", price: 100 },
      { id: "iced-caramel", name: "Iced Caramel", price: 100 },
      { id: "iced-latte", name: "Iced Latte", price: 100 },
    ],
  },
  {
    id: "frappes",
    name: "Frappés",
    nameAr: "فرابيه",
    original: "Frappes",
    items: [
      { id: "frappe-chocolate", name: "Chocolate Frappuccino", price: 120 },
      { id: "frappe-classic", name: "Classic Frappuccino", price: 120 },
      { id: "frappe-vanilla", name: "Vanilla Frappuccino", price: 120 },
      { id: "frappe-pistachio", name: "Pistachio Frappuccino", price: 140 },
      { id: "frappe-caramel", name: "Caramel Frappuccino", price: 120 },
    ],
  },
  {
    id: "milkshakes",
    name: "Milkshakes",
    nameAr: "ميلك شيك",
    original: "Milkshakes",
    items: [
      { id: "shake-vanilla", name: "Vanilla Shake", price: 110 },
      { id: "shake-pistachio", name: "Pistachio Shake", price: 140 },
      { id: "shake-lotus", name: "Lotus Shake", price: 110 },
      { id: "shake-caramel", name: "Caramel Shake", price: 110 },
      { id: "shake-chocolate", name: "Chocolate Shake", price: 110 },
    ],
  },
];

/** Every id on the page, for the router and the category nav to agree on. */
export const CATEGORY_IDS = MENU.map((category) => category.id);

export const ITEM_COUNT = MENU.reduce((total, category) => total + category.items.length, 0);

/**
 * Categories by id, for the router.
 *
 * `/menu/cookie-pans` has to resolve to a category before anything can be
 * rendered, and doing that with `MENU.find` inside a component means a linear
 * scan of seventeen entries on every render of the page *and* of the category
 * bar's seventeen links. Built once, here, beside the data it indexes.
 */
export const CATEGORY_BY_ID: ReadonlyMap<string, MenuCategory> = new Map(
  MENU.map((category) => [category.id, category]),
);

/** The cheapest item in a category, for the "from …" line under its heading. */
export function priceFrom(category: MenuCategory): number {
  return category.items.reduce((low, item) => Math.min(low, item.price), Infinity);
}

/* ────────────────────────────────────────────────────────────────────────────
   Groups
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * A top-level section of the menu, holding several of the categories above.
 *
 * Seventeen printed headings is the right level of detail for a *price list*
 * and the wrong one for *navigation*: seven of them are kinds of cookie, and a
 * bar carrying all seventeen made the reader scroll sideways through a list
 * whose first half all said "cookie" before they could find the coffee. So the
 * bar now carries three groups and each group's page shows its categories in
 * full, one under the next.
 *
 * The categories themselves are untouched. They are what the sheets print, they
 * are what the Arabic names and the ids belong to, and they are still the unit
 * a heading and an anchor correspond to — `/menu/cookies#cookie-pans`. A group
 * is purely a layer of navigation over them, which is why it is defined as a
 * list of ids rather than by moving the category literals around: the printed
 * order of the sheets stays readable in one place, and regrouping is a
 * three-line edit that cannot lose an item.
 */
export interface MenuGroup {
  /** Stable, and the route: `/menu/cookies`. */
  id: string;
  name: string;
  nameAr: string;
  categories: MenuCategory[];
}

/**
 * Which categories each group holds, in the order they are shown.
 *
 * Order within a group is deliberate and is *not* the order of `MENU` — the
 * sheets print Brownies & Brookies between Cookie Cake and Cookie Boxes, which
 * puts a non-cookie in the middle of the cookies. Here the seven cookie
 * categories run together and the brownies sit with the other desserts.
 */
const GROUP_PLAN = [
  {
    id: "cookies",
    name: "Cookies",
    nameAr: "كوكيز",
    categoryIds: [
      "plain-cookies",
      "cookie-pans",
      "cookie-cups",
      "cookie-tagines",
      "cookie-scoops",
      "cookie-cake",
      "cookie-boxes",
    ],
  },
  {
    id: "desserts",
    name: "Desserts",
    nameAr: "حلويات",
    categoryIds: [
      "brownies-brookies",
      "tagines",
      "molten-cakes",
      "cheesecakes-tarts",
      "gateaux",
      "biscuits-kahk",
    ],
  },
  {
    id: "drinks",
    name: "Drinks",
    nameAr: "مشروبات",
    categoryIds: ["coffee", "iced-coffee", "frappes", "milkshakes"],
  },
] as const;

/**
 * Resolved once, at module load.
 *
 * An id in `GROUP_PLAN` that names no category would otherwise render as a hole
 * in the page — a group one section short, with no error anywhere. It throws
 * instead: this is static data read at import time, so a typo here is a
 * build-and-first-load failure rather than something a customer discovers.
 * `menu.test.ts` covers the other half, that no category is left out of every
 * group or claimed by two.
 */
export const MENU_GROUPS: MenuGroup[] = GROUP_PLAN.map((plan) => ({
  id: plan.id,
  name: plan.name,
  nameAr: plan.nameAr,
  categories: plan.categoryIds.map((id) => {
    const category = CATEGORY_BY_ID.get(id);
    if (!category) throw new Error(`Menu group "${plan.id}" names unknown category "${id}"`);
    return category;
  }),
}));

/** Groups by id, for the router. */
export const GROUP_BY_ID: ReadonlyMap<string, MenuGroup> = new Map(
  MENU_GROUPS.map((group) => [group.id, group]),
);

/**
 * The group a category belongs to.
 *
 * This is what keeps every `/menu/cookie-pans` link that was ever shared or
 * bookmarked working: it still names a real thing, and that thing is now a
 * section of a page rather than a page. The router resolves it here and lands
 * the reader on `/menu/cookies#cookie-pans`.
 */
export const GROUP_BY_CATEGORY_ID: ReadonlyMap<string, MenuGroup> = new Map(
  MENU_GROUPS.flatMap((group) => group.categories.map((category) => [category.id, group] as const)),
);

/** Every item in a group, for the count under its heading. */
export function groupItemCount(group: MenuGroup): number {
  return group.categories.reduce((total, category) => total + category.items.length, 0);
}

/** The cheapest item anywhere in a group, for the "from …" line. */
export function groupPriceFrom(group: MenuGroup): number {
  return group.categories.reduce((low, category) => Math.min(low, priceFrom(category)), Infinity);
}
