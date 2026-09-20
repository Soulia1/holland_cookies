import { describe, expect, it } from "vitest";
import {
  CAIRO, CAIRO_AREAS, DEFAULT_AREAS, GIZA, GIZA_AREAS, areasByCity,
} from "../../shared/deliveryAreas.mjs";
import { areaFee, deliveryFee } from "../../shared/productPricing.mjs";

/*
 * The delivery areas the shop starts with, and the grouping checkout renders
 * them under.
 *
 * The ids are what orders store: an order records `area: "nasr-city"` and every
 * later reading of it — the dashboard's order view, the receipt, the courier's
 * printout — looks the name up from that id. So an id that changes does not
 * rename an area, it *orphans every order already placed to it*, and the only
 * symptom is a blank where a neighbourhood should be. Hence the assertions on
 * shape rather than on the list's contents, which the shop edits freely.
 */

describe("the starting delivery areas", () => {
  it("cover Cairo and Giza, and nothing else", () => {
    expect(DEFAULT_AREAS).toEqual([...CAIRO_AREAS, ...GIZA_AREAS]);
    expect(new Set(DEFAULT_AREAS.map((area) => area.city))).toEqual(new Set([CAIRO, GIZA]));
  });

  it("give every area a stable id, an English and an Arabic name", () => {
    for (const area of DEFAULT_AREAS) {
      expect(area.id, `${area.name} has an id the server would refuse`).toMatch(/^[a-z0-9-]+$/);
      expect(area.name.trim()).not.toBe("");
      expect(area.nameAr, `${area.id} has no Arabic name`).toMatch(/\p{Script=Arabic}|[٠-٩]/u);
      expect(area.cityAr).toMatch(/\p{Script=Arabic}/u);
    }
  });

  it("never repeats an id", () => {
    const ids = DEFAULT_AREAS.map((area) => area.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays inside the 80 the server accepts", () => {
    expect(DEFAULT_AREAS.length).toBeLessThanOrEqual(80);
  });
});

describe("areasByCity", () => {
  it("keeps each governorate together, in the order the list gives", () => {
    const groups = areasByCity(DEFAULT_AREAS);
    expect(groups.map((group) => group.city)).toEqual([CAIRO, GIZA]);
    expect(groups[0].areas).toEqual(CAIRO_AREAS);
    expect(groups[1].areas).toEqual(GIZA_AREAS);
  });

  it("still offers an area saved before governorates existed", () => {
    // The real failure this guards: dropping such an area from the select is an
    // order the shop does not get, and it would look like a styling bug.
    const groups = areasByCity([
      { id: "nasr-city", name: "Nasr City", city: CAIRO, cityAr: "القاهرة" },
      { id: "somewhere", name: "Somewhere" },
    ]);
    expect(groups).toHaveLength(2);
    // Unlabelled last, so the named groups are not pushed down by it.
    expect(groups[1].city).toBe("");
    expect(groups[1].areas.map((area) => area.id)).toEqual(["somewhere"]);
  });

  it("answers with nothing for a shop that has configured no areas", () => {
    expect(areasByCity([])).toEqual([]);
    expect(areasByCity(undefined)).toEqual([]);
  });
});

/*
 * What delivery to an area costs.
 *
 * The distinction this is really about is between "no price set" and "free".
 * `area.fee || settings.deliveryFee` reads them as the same thing, and the area
 * the shop delivers to free would quietly start charging 40 again.
 */
const shop = {
  deliveryFee: 40,
  freeDeliveryOver: 600,
  areas: [
    { id: "nasr-city", name: "Nasr City" },
    { id: "haram", name: "Haram", fee: 70 },
    { id: "downtown", name: "Downtown", fee: 0 },
    { id: "zamalek", name: "Zamalek", fee: null },
  ],
};

describe("an area's own delivery price", () => {
  it("charges the area's price where it has one", () => {
    expect(areaFee(shop, "haram")).toBe(70);
  });

  it("falls back to the shop's fee where the area names none", () => {
    expect(areaFee(shop, "nasr-city")).toBe(40);
    expect(areaFee(shop, "zamalek")).toBe(40);
    expect(areaFee(shop, undefined)).toBe(40);
    // An area the shop no longer offers: priced at the default here, and
    // refused by the order transaction, which is what the customer is told.
    expect(areaFee(shop, "no-such-area")).toBe(40);
  });

  it("keeps a free area free", () => {
    expect(areaFee(shop, "downtown")).toBe(0);
    expect(deliveryFee(100, shop, "delivery", "downtown")).toBe(0);
  });

  it("is waived over the free-delivery threshold, whatever the area charges", () => {
    expect(deliveryFee(599.99, shop, "delivery", "haram")).toBe(70);
    expect(deliveryFee(600, shop, "delivery", "haram")).toBe(0);
  });

  it("is nothing on pickup", () => {
    expect(deliveryFee(100, shop, "pickup", "haram")).toBe(0);
  });
});
