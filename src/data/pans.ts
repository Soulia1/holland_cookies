/**
 * The menu, as plain data.
 *
 * Deliberately a static module rather than a fetch. This site is a storefront
 * page, not an ordering system — there is no backend here, and inventing one to
 * serve three fixed products would be architecture for its own sake. When a real
 * menu service exists, only this module changes: nothing in the interaction
 * layer knows where the list came from.
 */

export interface Pan {
  id: string;
  name: string;
  price: number;
  currency: string;
  blurb: string;
  /** The longer copy, shown only in the detail modal. */
  detail: string;
  image: string;
  /** Alt text. Written for someone who cannot see the photograph. */
  alt: string;
  serves: string;
}

export const PANS: Pan[] = [
  {
    id: "classic-chocolate-chip-pan",
    name: "Classic Chocolate Chip Pan",
    price: 180,
    currency: "EGP",
    blurb: "Brown-butter dough, Belgian chips, baked to a soft molten centre.",
    detail:
      "The one we would be judged on. Brown butter folded through the dough the "
      + "night before so it has time to deepen, Belgian chips throughout, and a "
      + "bake stopped early enough that the middle is still soft when it reaches "
      + "you. Best eaten with a fork, straight from the pan.",
    image: "/img/pan-classic.jpg",
    alt: "A thick, golden chocolate chip cookie pie baked in an aluminium pan, studded with chips.",
    serves: "Serves 2–4",
  },
  {
    id: "milk-chocolate-pull-apart",
    name: "Milk Chocolate Pull-Apart",
    price: 220,
    currency: "EGP",
    blurb: "Six stuffed cookie domes crowned with warm melted milk chocolate.",
    detail:
      "Six domes baked together so they join at the edges and tear apart by hand. "
      + "Each one is stuffed before baking and the whole pan is finished with milk "
      + "chocolate poured over the top while it is still hot, so it sets into the "
      + "seams rather than sitting on the surface.",
    image: "/img/pan-pullapart.jpg",
    alt: "A pan of joined cookie domes topped with pools of melted milk chocolate.",
    serves: "Serves 3–4",
  },
  {
    id: "stuffed-cookie-pie-slice",
    name: "Stuffed Cookie Pie Slice",
    price: 95,
    currency: "EGP",
    blurb: "A thick wedge with a river of hazelnut chocolate running through it.",
    detail:
      "A single wedge cut from the deep pie: two layers of cookie with a seam of "
      + "hazelnut chocolate sealed between them. The layer stays molten for a good "
      + "while after it leaves the oven, which is the entire point of ordering one "
      + "rather than a whole pan.",
    image: "/img/pan-slice.jpg",
    alt: "A thick wedge of stuffed cookie pie showing a molten hazelnut chocolate centre.",
    serves: "Serves 1",
  },
];
