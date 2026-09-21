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

/** An option the customer picks exactly one of before adding an item. */
export interface MenuChoice {
  name: string;
  nameAr?: string;
  /**
   * What picking this option adds to the item's price, in pounds.
   *
   * The item keeps one price and each option says what it costs on top of it,
   * so a repricing is one edit rather than one per option. Absent or zero means
   * the option costs no more than the item. Edited in the dashboard; the
   * arithmetic is in `shared/pricing.mjs` and the server applies it again when
   * the order is placed.
   */
  priceDelta?: number;
}

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
  /**
   * Options the customer must pick exactly one of before adding this item —
   * here, the flavors of a printed line that names several. This copy only
   * seeds the database; the dashboard edits the list from then on, and the
   * live catalogue's version is what the page shows.
   */
  choices?: MenuChoice[];
  /** From the live catalogue: an admin marked it unavailable. */
  soldOut?: boolean;
  /** From the live catalogue: a photo an admin set, which wins over the bundled one. */
  image?: string;
  /** From the live catalogue: a description an admin wrote, which wins over the generated one. */
  description?: string;
  descriptionAr?: string;
  /** From the live catalogue: what a bundle contains, or the choices it asks for. */
  bundle?: MenuBundle;
}

export interface MenuBundle {
  type: "fixed" | "choice";
  components: { productId: string; name: string; nameAr?: string; quantity: number }[];
  groups: {
    label: string;
    labelAr?: string;
    choose: number;
    allowRepeats: boolean;
    options: {
      productId: string; name: string; nameAr?: string; surcharge: number; available: boolean;
    }[];
  }[];
}

export interface MenuCategory {
  /** Stable, and the anchor target: `/menu#cookie-pans`. */
  id: string;
  /**
   * The menu page this category is shown on, where it is known.
   *
   * Carried on the category rather than looked up, because a category created
   * in the dashboard is in no group's plan — it names its page in the database
   * instead — and everything downstream of the page (the lead-time notice, the
   * cart) needs one answer that works for both kinds.
   */
  group?: string;
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
    id: "cookie-pans",
    name: "Cookie Pans",
    nameAr: "كوكي بان",
    original: "كوكي بان",
    items: [
      { id: "pan-vanilla-nutella", name: "Vanilla, Nutella filling", price: 150 },
      { id: "pan-vanilla-bueno", name: "Vanilla, Kinder Bueno filling", price: 150 },
      { id: "pan-chocolate-bueno", name: "Chocolate, Kinder Bueno filling", price: 150 },
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
        id: "tagine-kunafa-coffee-small",
        name: "Coffee Kunafa Cookie",
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
        name: "Vanilla, Red Velvet or Chocolate — Nutella or white Nutella filling",
        price: 300,
        note: "Foil tray",
        choices: [
          { name: "Red Velvet, white Nutella filling" },
          { name: "Vanilla, Nutella filling" },
          { name: "Chocolate, white Nutella filling" },
          { name: "Chocolate, Nutella filling" },
        ],
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
  /*
   * Special Edition — the one category here that is NOT a transcription.
   *
   * The rule at the top of this file still holds for the three printed sheets:
   * nothing on them was invented. This category was asked for by the shop on
   * 2026-09-20, after those sheets were printed, and its two items are starting
   * rows rather than a record of anything printed. They exist so the category
   * is a real, orderable page from the first deploy instead of an empty
   * heading, and every word and figure in them is editable in the dashboard —
   * which is where the shop's own special editions will be typed.
   *
   * They are also this file's only worked example of options that change the
   * price: each carries two sizes, one at the item's own price and one dearer.
   */
  {
    // Not "special-edition": that id belongs to the *group* below, and the two
    // share a path segment — `/menu/special-edition` can only resolve to one of
    // them. `menu.test.ts` fails on the collision.
    id: "special-edition-cookies",
    name: "Special Edition Cookies",
    nameAr: "كوكيز الإصدار الخاص",
    original: "Special Edition",
    items: [
      {
        id: "special-dubai-chocolate-cookie",
        name: "Dubai Chocolate Cookie",
        nameAr: "كوكي شوكولاتة دبي",
        price: 180,
        choices: [
          { name: "Regular", nameAr: "عادي", priceDelta: 0 },
          { name: "Large", nameAr: "كبير", priceDelta: 60 },
        ],
      },
      {
        id: "special-pistachio-kunafa-pan",
        name: "Pistachio Kunafa Cookie Pan",
        nameAr: "كوكي بان كنافة بالفستق",
        price: 220,
        choices: [
          { name: "Tray for two", nameAr: "صينية لشخصين", priceDelta: 0 },
          { name: "Family tray", nameAr: "صينية عائلية", priceDelta: 120 },
        ],
      },
    ],
  },
];

/** Every id on the page, for the router and the category nav to agree on. */
export const CATEGORY_IDS = MENU.map((category) => category.id);

export const ITEM_COUNT = MENU.reduce((total, category) => total + category.items.length, 0);

/**
 * The printed categories by id, before a group has been put on them.
 *
 * Private: everything outside this file wants `CATEGORY_BY_ID` below, whose
 * entries are the *same objects* the groups hold, so a category found through
 * the router and one found through its group are one thing and not two copies
 * that can disagree.
 */
const PRINTED_BY_ID: ReadonlyMap<string, MenuCategory> = new Map(
  MENU.map((category) => [category.id, category]),
);

/**
 * The least this item can cost: its price plus the cheapest of its options.
 *
 * An item whose every option carries an extra can never be bought at its bare
 * price, so printing that figure on the row would advertise a price the shop
 * does not sell at. The cheapest option is always orderable, so this one is.
 */
export function itemPriceFrom(item: MenuItem): number {
  const choices = item.choices ?? [];
  if (!choices.length) return item.price;
  const least = choices.reduce(
    (low, choice) => Math.min(low, Math.max(0, choice.priceDelta ?? 0)),
    Infinity,
  );
  return item.price + (Number.isFinite(least) ? least : 0);
}

/** Whether the options price this item differently, so its row reads "from …". */
export function itemPriceVaries(item: MenuItem): boolean {
  const extras = (item.choices ?? []).map((choice) => Math.max(0, choice.priceDelta ?? 0));
  return new Set(extras).size > 1;
}

/** The cheapest item in a category, for the "from …" line under its heading. */
export function priceFrom(category: MenuCategory): number {
  return category.items.reduce((low, item) => Math.min(low, itemPriceFrom(item)), Infinity);
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
  /**
   * Working days between the order and the handover, where this page needs
   * them. Absent means the shop bakes it the same way it bakes everything else.
   *
   * On the group rather than on each item, because it is a fact about how that
   * part of the menu is made rather than about one cookie — and because it then
   * covers a category the shop adds to that page tomorrow without anybody
   * remembering to set a field on it.
   */
  leadDays?: number;
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
    categoryIds: ["brownies-brookies", "molten-cakes", "cheesecakes-tarts"],
  },
  {
    id: "drinks",
    name: "Drinks",
    nameAr: "مشروبات",
    categoryIds: ["coffee", "iced-coffee", "frappes", "milkshakes"],
  },
  // Last in the bar rather than first, deliberately: a group's position is read
  // off this list by index in several places, and the three printed groups
  // keeping theirs is what stops an unrelated link or test meaning something
  // else after this edit.
  {
    id: "special-edition",
    name: "Special Edition",
    nameAr: "إصدار خاص",
    // Made to order: the shop asked for two working days' notice on this page,
    // and the customer is told so before they add it, in the cart and at
    // checkout rather than after the order is placed.
    leadDays: 2,
    categoryIds: ["special-edition-cookies"],
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
  ...("leadDays" in plan ? { leadDays: plan.leadDays } : {}),
  categories: plan.categoryIds.map((id) => {
    const category = PRINTED_BY_ID.get(id);
    if (!category) throw new Error(`Menu group "${plan.id}" names unknown category "${id}"`);
    // The page it is on, put on the category itself: the cart and the item
    // dialog are handed a category and nothing else, and a lookup back to the
    // plan from there is a second description of the same fact.
    return { ...category, group: plan.id };
  }),
}));

/**
 * Categories by id, for the router.
 *
 * `/menu/cookie-pans` has to resolve to a category before anything can be
 * rendered, and doing that with `MENU.find` inside a component means a linear
 * scan of seventeen entries on every render of the page *and* of the category
 * bar's seventeen links. Built once, here, from the grouped categories, so the
 * object this returns is the object the page renders.
 */
export const CATEGORY_BY_ID: ReadonlyMap<string, MenuCategory> = new Map(
  MENU_GROUPS.flatMap((group) => group.categories.map((category) => [category.id, category] as const)),
);

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

/**
 * The working days a page needs between the order and the handover, or 0.
 *
 * Asked by id rather than by holding the group, because the cart knows a
 * product's category and nothing else — and a category the dashboard created
 * names its page in the database, so its id is all there is to go on.
 */
export function leadDaysForGroup(groupId: string | undefined | null): number {
  if (!groupId) return 0;
  return GROUP_BY_ID.get(groupId)?.leadDays ?? 0;
}

/**
 * The same, for a category: the page a printed category is planned onto, or the
 * one a dashboard-created category names.
 */
export function leadDaysForCategory(categoryId: string, storedGroup?: string): number {
  const planned = GROUP_BY_CATEGORY_ID.get(categoryId);
  return planned ? planned.leadDays ?? 0 : leadDaysForGroup(storedGroup);
}

/** Every item in a group, for the count under its heading. */
export function groupItemCount(group: MenuGroup): number {
  return group.categories.reduce((total, category) => total + category.items.length, 0);
}

/** The cheapest item anywhere in a group, for the "from …" line. */
export function groupPriceFrom(group: MenuGroup): number {
  return group.categories.reduce((low, category) => Math.min(low, priceFrom(category)), Infinity);
}
