/**
 * The box builder's options.
 *
 * Deliberately *not* a second copy of the products. The names and prices come
 * from the Cookie Boxes category in `menu.ts` by id, so a price change there is
 * a price change here and there is no second number to forget. All this module
 * adds is the one thing the printed menu has no way to carry: a photograph.
 *
 * **The photographs are stand-ins.** There is one real box photograph in this
 * project (`craft-box.jpg`); the other three are pan shots standing in for
 * boxes that have not been photographed yet. Replace `image` with real
 * photography before this goes near a customer — nothing else needs to change.
 */

import { MENU, type MenuItem } from "./menu";

export interface BoxOption extends MenuItem {
  image: string;
  alt: string;
}

/** Photographs, keyed by the menu item's own stable id. */
const PHOTOS: Record<string, { image: string; alt: string }> = {
  "box-mixed-cookies": {
    image: "/img/craft-box.jpg",
    alt: "An open Holland Cookies box holding three cookie pans in their pans.",
  },
  "box-mini-mixed": {
    image: "/img/pan-pullapart.jpg",
    alt: "A pan of joined cookie domes topped with pools of melted milk chocolate.",
  },
  "box-cookie-cups": {
    image: "/img/pan-classic.jpg",
    alt: "A thick, golden chocolate chip cookie pie baked in an aluminium pan.",
  },
  "box-plain-cookies": {
    image: "/img/pan-slice.jpg",
    alt: "A thick wedge of stuffed cookie pie showing a molten hazelnut chocolate centre.",
  },
};

const CATEGORY = MENU.find((category) => category.id === "cookie-boxes");

/**
 * Ordered the way the section reads best — the largest box first — rather than
 * in menu order. Anything in the category without a photograph is left out
 * rather than rendered as an empty frame.
 */
const ORDER = ["box-mixed-cookies", "box-mini-mixed", "box-cookie-cups", "box-plain-cookies"];

export const BOXES: BoxOption[] = ORDER.flatMap((id) => {
  const item = CATEGORY?.items.find((candidate) => candidate.id === id);
  const photo = PHOTOS[id];
  return item && photo ? [{ ...item, ...photo }] : [];
});
