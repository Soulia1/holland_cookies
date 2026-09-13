/**
 * The product categories, loaded once from the API and cached for the page.
 *
 * The synchronous helpers answer from that cache for the bundle editor. Before
 * it arrives they return nothing rather than guessing. Asked for by the Menu
 * page after sign-in, never on import, so the sign-in screen does not fetch.
 */

import { menuApi } from "@/lib/api";

let loaded: { id: string; name: string; nameAr: string }[] | null = null;
let inFlight: Promise<void> | null = null;

/** Safe to call repeatedly; only the first call fetches. A failure is not cached. */
export function loadCategories(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!inFlight) {
    inFlight = menuApi.categories()
      .then((categories) => { loaded = categories; })
      .catch(() => {})
      .finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** Forget the cache so a category just created or deleted shows up. */
export function invalidateCategories(): void {
  loaded = null;
  inFlight = null;
}

export function categoryName(id: string): string {
  return (loaded ?? []).find((category) => category.id === id)?.name ?? id;
}

export function categoryOptions(): { id: string; name: string }[] {
  return (loaded ?? []).map((category) => ({ id: category.id, name: category.name }));
}
