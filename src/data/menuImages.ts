/**
 * A photograph for a menu item, keyed by item id.
 *
 * Deliberately a separate module from `menu.ts` rather than an `image` field on
 * `MenuItem`, and the reason is the rule that file states about itself: it is a
 * transcription of three printed sheets, nothing in it was invented, and the
 * sheets are the source of truth. Photography is a different kind of fact, from
 * a different source, arriving on a different schedule — the shop sends pictures
 * over WhatsApp long after the prices were set. Threading it through a hundred
 * and five item literals would mix the two and make every future photo drop a
 * diff against the transcription.
 *
 * So the transcription stays closed and this map is the open thing. An id that
 * is not in here has no photograph *yet*, which is a normal state and not an
 * error: `MenuPage` renders a branded placeholder in the same box, so a row
 * without a picture is still a row of the same height rather than a hole. A
 * grid where some rows lack their media block reads as a loading failure.
 *
 * The files come from `tools/build-menu-thumbs.py`, which cuts one square out
 * of each of the shop's photographs. Several ids can point at one file on
 * purpose: the sheets list "Vanilla, Red Velvet or Chocolate — Nutella filling"
 * as a single item, and one tray was photographed once.
 */

const BASE = "/img/menu";

/**
 * item id -> file, for every item the shop has actually photographed.
 *
 * Entries are only added where the photograph and the printed item genuinely
 * correspond. Six of the twenty-five crops are *not* here — a chocolate scoop
 * tray, a red velvet scoop tray, a vanilla tray with mixed fillings, two
 * chocolate slices and a red velvet cheesecake — because no printed item names
 * them unambiguously, and putting a picture of one dessert against the name of
 * another is the same class of mistake as inventing a description for it.
 */
const PHOTOGRAPHED: Readonly<Record<string, string>> = {
  // Cookie Pans
  "pan-vanilla-nutella": `${BASE}/pan-vanilla-nutella.webp`,
  "pan-red-velvet-white-nutella": `${BASE}/pan-red-velvet-white.webp`,

  // Cookie Cups — two photographs, three cups in each, cut apart.
  "cup-vanilla-lotus": `${BASE}/cup-caramel.webp`,
  "cup-vanilla-nutella": `${BASE}/cup-vanilla-nutella.webp`,
  "cup-chocolate-nutella": `${BASE}/cup-chocolate-nutella.webp`,
  "cup-chocolate-pistachio": `${BASE}/cup-chocolate-pistachio.webp`,
  "cup-red-velvet-nutella": `${BASE}/cup-red-velvet-nutella.webp`,
  "cup-red-velvet-white-nutella": `${BASE}/cup-red-velvet-white.webp`,

  // Cookie Tagines — the two cross-sections and the one labelled photograph.
  "tagine-vanilla-nutella": `${BASE}/cut-vanilla-nutella.webp`,
  "tagine-chocolate-nutella": `${BASE}/cut-chocolate-nutella.webp`,
  "tagine-matilda": `${BASE}/matilda.webp`,
  "tagine-red-velvet-crunchy": `${BASE}/cut-red-velvet-cream.webp`,

  // Cookie Scoops
  "scoop-nutella-foil": `${BASE}/scoop-vanilla-nutella.webp`,
  "scoop-mixed-foil": `${BASE}/scoop-mixed.webp`,
  "scoop-vanilla-medium-foil": `${BASE}/scoop-vanilla.webp`,

  // Cookie Cake
  "cake-vanilla-nutella": `${BASE}/cake-vanilla-wedge.webp`,

  // Brownies & Brookies
  "classic-brookie": `${BASE}/brookie-classic.webp`,
  "red-velvet-brookie": `${BASE}/slice-red-velvet-cream.webp`,

  // Cheesecakes & Tarts
  "apple-tart-slice": `${BASE}/apple-tart.webp`,
};

/**
 * Generated stand-ins, one per item, produced by `tools/build-flow-jobs.py` and
 * `flow-batch.mjs` against Google Flow in the home page's house style.
 *
 * Regenerate with `python tools/install-flow-thumbs.py`, which writes the crops
 * and prints this block.
 */
const GENERATED: Readonly<Record<string, string>> = {
  /* GENERATED-START */
  "box-cookie-cups": "/img/menu/ai/box-cookie-cups.webp",
  "box-mini-mixed": "/img/menu/ai/box-mini-mixed.webp",
  "box-mixed-cookies": "/img/menu/ai/box-mixed-cookies.webp",
  "box-plain-cookies": "/img/menu/ai/box-plain-cookies.webp",
  "brownies": "/img/menu/ai/brownies.webp",
  "cake-chocolate-bueno": "/img/menu/ai/cake-chocolate-bueno.webp",
  "cake-chocolate-nutella": "/img/menu/ai/cake-chocolate-nutella.webp",
  "cake-red-velvet-white-nutella": "/img/menu/ai/cake-red-velvet-white-nutella.webp",
  "cappuccino": "/img/menu/ai/cappuccino.webp",
  "cheesecake-baked-plain": "/img/menu/ai/cheesecake-baked-plain.webp",
  "cheesecake-blueberry": "/img/menu/ai/cheesecake-blueberry.webp",
  "cheesecake-lotus": "/img/menu/ai/cheesecake-lotus.webp",
  "cheesecake-pistachio": "/img/menu/ai/cheesecake-pistachio.webp",
  "cheesecake-raspberry": "/img/menu/ai/cheesecake-raspberry.webp",
  "cortado": "/img/menu/ai/cortado.webp",
  "cup-chocolate-bueno": "/img/menu/ai/cup-chocolate-bueno.webp",
  "despacito": "/img/menu/ai/despacito.webp",
  "despacito-bueno": "/img/menu/ai/despacito-bueno.webp",
  "despacito-chocolate": "/img/menu/ai/despacito-chocolate.webp",
  "despacito-pistachio": "/img/menu/ai/despacito-pistachio.webp",
  "despacito-white-nutella": "/img/menu/ai/despacito-white-nutella.webp",
  "espresso": "/img/menu/ai/espresso.webp",
  "flat-white": "/img/menu/ai/flat-white.webp",
  "frappe-caramel": "/img/menu/ai/frappe-caramel.webp",
  "frappe-chocolate": "/img/menu/ai/frappe-chocolate.webp",
  "frappe-classic": "/img/menu/ai/frappe-classic.webp",
  "frappe-pistachio": "/img/menu/ai/frappe-pistachio.webp",
  "frappe-vanilla": "/img/menu/ai/frappe-vanilla.webp",
  "french-coffee": "/img/menu/ai/french-coffee.webp",
  "hot-chocolate": "/img/menu/ai/hot-chocolate.webp",
  "iced-caramel": "/img/menu/ai/iced-caramel.webp",
  "iced-caramel-macchiato": "/img/menu/ai/iced-caramel-macchiato.webp",
  "iced-coffee": "/img/menu/ai/iced-coffee.webp",
  "iced-latte": "/img/menu/ai/iced-latte.webp",
  "iced-mocha": "/img/menu/ai/iced-mocha.webp",
  "latte": "/img/menu/ai/latte.webp",
  "macchiato": "/img/menu/ai/macchiato.webp",
  "mocha": "/img/menu/ai/mocha.webp",
  "molten-chocolate": "/img/menu/ai/molten-chocolate.webp",
  "molten-lotus": "/img/menu/ai/molten-lotus.webp",
  "molten-nutella": "/img/menu/ai/molten-nutella.webp",
  "molten-red-velvet": "/img/menu/ai/molten-red-velvet.webp",
  "pan-chocolate-bueno": "/img/menu/ai/pan-chocolate-bueno.webp",
  "pan-chocolate-nutella": "/img/menu/ai/pan-chocolate-nutella.webp",
  "pan-lotus-smores": "/img/menu/ai/pan-lotus-smores.webp",
  "pan-vanilla-bueno": "/img/menu/ai/pan-vanilla-bueno.webp",
  "scoop-half-vanilla-bueno-foil": "/img/menu/ai/scoop-half-vanilla-bueno-foil.webp",
  "scoop-half-vanilla-bueno-kraft": "/img/menu/ai/scoop-half-vanilla-bueno-kraft.webp",
  "scoop-half-vanilla-chocolate-foil": "/img/menu/ai/scoop-half-vanilla-chocolate-foil.webp",
  "scoop-half-vanilla-chocolate-kraft": "/img/menu/ai/scoop-half-vanilla-chocolate-kraft.webp",
  "scoop-vanilla-bueno-foil": "/img/menu/ai/scoop-vanilla-bueno-foil.webp",
  "shake-caramel": "/img/menu/ai/shake-caramel.webp",
  "shake-chocolate": "/img/menu/ai/shake-chocolate.webp",
  "shake-lotus": "/img/menu/ai/shake-lotus.webp",
  "shake-pistachio": "/img/menu/ai/shake-pistachio.webp",
  "shake-vanilla": "/img/menu/ai/shake-vanilla.webp",
  "tagine-chocolate-white-nutella": "/img/menu/ai/tagine-chocolate-white-nutella.webp",
  "tagine-coffee-nutella": "/img/menu/ai/tagine-coffee-nutella.webp",
  "tagine-kunafa-chocolate-small": "/img/menu/ai/tagine-kunafa-chocolate-small.webp",
  "tagine-kunafa-vanilla-small": "/img/menu/ai/tagine-kunafa-vanilla-small.webp",
  "tagine-red-velvet-white-nutella": "/img/menu/ai/tagine-red-velvet-white-nutella.webp",
  "tagine-vanilla-nutella-coffee": "/img/menu/ai/tagine-vanilla-nutella-coffee.webp",
  "turkish-coffee": "/img/menu/ai/turkish-coffee.webp",
  /* GENERATED-END */
};

/**
 * What the page actually shows, with the photograph winning wherever there is
 * one.
 *
 * The order of this spread is the whole policy: a real picture of the real
 * product beats a plausible picture of it, so `PHOTOGRAPHED` goes second and
 * overwrites. A generated image is a stand-in until the shop sends a photograph
 * of that item, and the day it does, adding one line above is enough — nothing
 * has to be removed from the generated set for it to take effect.
 */
export const MENU_IMAGES: Readonly<Record<string, string>> = {
  ...GENERATED,
  ...PHOTOGRAPHED,
};

/** The photograph for an item, or undefined if it has neither kind of image. */
export function itemImage(id: string): string | undefined {
  return MENU_IMAGES[id];
}

/** Whether an item's picture is a real photograph rather than a generated one. */
export function isPhotograph(id: string): boolean {
  return id in PHOTOGRAPHED;
}

/** How many items the shop has actually photographed. */
export const PHOTOGRAPHED_COUNT = Object.keys(PHOTOGRAPHED).length;
