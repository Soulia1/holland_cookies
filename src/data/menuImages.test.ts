import { describe, expect, it } from "vitest";
import { MENU } from "./menu";
import { MENU_IMAGES, isPhotograph, itemImage } from "./menuImages";

/*
 * The photograph map is keyed by item id, and nothing at build time checks that
 * those keys name anything.
 *
 * That is the whole reason this file exists. `menu.ts` throws on a group naming
 * a category that does not exist, because the page cannot be built without it.
 * A photograph is the opposite: an id with a typo in it simply never matches an
 * item, `itemImage` returns undefined, and the row renders the placeholder tile
 * that an unphotographed item is *supposed* to render. The picture is on disk,
 * the map says it is assigned, and the page looks exactly like a menu that is
 * still waiting for the shop to send it. There is no error, no warning, and no
 * visible difference between "not shot yet" and "shot, and misfiled".
 *
 * So: every key must name a real item. The other direction is deliberately not
 * asserted — an item with no photograph is the normal state of most of this
 * menu, not a failure.
 */

const ITEM_IDS = new Set(MENU.flatMap((category) => category.items.map((item) => item.id)));

describe("menu photographs", () => {
  it("every mapped id names a real menu item", () => {
    const orphans = Object.keys(MENU_IMAGES).filter((id) => !ITEM_IDS.has(id));
    expect(orphans).toEqual([]);
  });

  it("every path points into the menu image directory", () => {
    for (const [id, path] of Object.entries(MENU_IMAGES)) {
      expect(path, id).toMatch(/^\/img\/menu\/(?:ai\/)?[a-z0-9-]+\.webp$/);
    }
  });

  it("itemImage resolves a mapped id and returns undefined for an unmapped one", () => {
    const [known] = Object.keys(MENU_IMAGES);
    expect(itemImage(known)).toBe(MENU_IMAGES[known]);
    // Deliberately not a real-but-unphotographed item id here. Every item is
    // expected to end up with a generated stand-in, so an id like "cappuccino"
    // would assert something that stops being true the day the batch lands —
    // a test failing because the work succeeded.
    expect(itemImage("no-such-item")).toBeUndefined();
  });

  it("a photographed item keeps its photograph rather than a generated one", () => {
    // The precedence rule in menuImages.ts, pinned. A generated file is written
    // for every item including this one, so the only thing keeping the real
    // picture on the page is the order of the spread.
    expect(isPhotograph("apple-tart-slice")).toBe(true);
    expect(MENU_IMAGES["apple-tart-slice"]).toBe("/img/menu/apple-tart.webp");
  });
});
