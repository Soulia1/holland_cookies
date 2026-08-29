/**
 * The product categories.
 *
 * Scooby's version of this file is a hardcoded list of five, mirrored from its
 * backend and kept in step by a test. Holland's categories live in the database
 * and an admin can add one, so a fixed list here would be wrong the moment they
 * did — and it *was* wrong on arrival: every one of the 105 products rendered
 * with "Needs a category", because none of them is called `cookies`.
 *
 * So the list is loaded once from the API and cached for the life of the page.
 * The synchronous helpers below are what the copied components call, and they
 * answer from that cache; before it arrives they accept everything, which is
 * the safe direction — a product briefly shown as valid and then flagged is far
 * better than the whole menu flashing an error on every load.
 */

import { menuApi } from "@/lib/api";

export type ProductCategory = string;

let loaded: { id: string; name: string; nameAr: string }[] | null = null;
let inFlight: Promise<void> | null = null;

/** Kick off the load. Safe to call repeatedly; only the first one fetches. */
export function loadCategories(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!inFlight) {
    inFlight = menuApi.categories()
      .then((categories) => { loaded = categories; })
      .catch(() => { loaded = []; })
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

// Requested as soon as anything imports this module, so the cache is usually
// warm by the time the first product row renders.
void loadCategories();

export function productCategories(): ProductCategory[] {
  return (loaded ?? []).map((category) => category.id);
}

export const CATEGORY_LABELS: Record<string, string> = new Proxy({}, {
  get(_target, key: string) {
    const found = (loaded ?? []).find((category) => category.id === key);
    // Falls back to the id rather than to "undefined": an unlabelled category
    // reading `cookie-pans` is still usable, and it is what the admin typed.
    return found?.name ?? key;
  },
  has() { return true; },
  ownKeys() { return (loaded ?? []).map((category) => category.id); },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true };
  },
});

export function isProductCategory(value: unknown): value is ProductCategory {
  if (typeof value !== "string" || !value) return false;
  // Before the list arrives, accept anything — see the note at the top.
  if (loaded === null) return true;
  return loaded.some((category) => category.id === value);
}

/** For the category `<select>` in the product editor. */
export function categoryOptions(): { id: string; name: string }[] {
  return (loaded ?? []).map((category) => ({ id: category.id, name: category.name }));
}
