import { useEffect, useState } from "react";
import { api, type ApiProduct } from "@/lib/api";
import { GROUP_BY_CATEGORY_ID, MENU_GROUPS, type MenuCategory, type MenuGroup, type MenuItem } from "@/data/menu";

/**
 * The catalogue as the dashboard last left it.
 *
 * The printed menu in `data/menu.ts` stays the page's structure — groups,
 * order, flavor choices, bundled photos — and this lays the database over it,
 * so a price, name, photo, availability or visibility change made in the
 * dashboard reaches the page. If the request fails the printed menu is shown
 * as it is.
 */
export interface LiveMenu {
  products: ReadonlyMap<string, ApiProduct>;
  /** In the API's order. `group` is the menu page a dashboard-created category is filed under. */
  categories: ReadonlyMap<string, { name: string; nameAr?: string; group?: string }>;
}

let pending: Promise<LiveMenu | null> | null = null;

function load(): Promise<LiveMenu | null> {
  pending ??= api.menu().then(
    ({ categories }) => ({
      products: new Map(categories.flatMap((c) => c.items.map((p) => [p.id, p] as const))),
      categories: new Map(categories.map((c) => [c.id, { name: c.name, nameAr: c.nameAr, group: c.group }])),
    }),
    () => {
      pending = null;
      return null;
    },
  );
  return pending;
}

export function useLiveMenu(): LiveMenu | null {
  const [live, setLive] = useState<LiveMenu | null>(null);
  useEffect(() => {
    let active = true;
    void load().then((result) => {
      if (active) setLive(result);
    });
    return () => {
      active = false;
    };
  }, []);
  return live;
}

function overlay(item: MenuItem, product: ApiProduct): MenuItem {
  return {
    ...item,
    name: product.name || item.name,
    nameAr: product.nameAr || item.nameAr,
    note: product.note || item.note,
    noteAr: product.noteAr || item.noteAr,
    price: product.price,
    image: product.image || undefined,
    description: product.description || undefined,
    descriptionAr: product.descriptionAr || undefined,
    soldOut: !product.available,
    bundle: product.isBundle
      ? {
          type: product.bundleType ?? "fixed",
          components: product.components ?? [],
          groups: product.groups ?? [],
        }
      : undefined,
  };
}

/** A category's rows: its printed items the database still has, then any added in the dashboard. */
function liveItems(live: LiveMenu, categoryId: string, printed: readonly MenuItem[]): MenuItem[] {
  const listed = new Set(printed.map((item) => item.id));
  const items: MenuItem[] = [];
  for (const item of printed) {
    const product = live.products.get(item.id);
    if (product) items.push(overlay(item, product));
  }
  for (const product of live.products.values()) {
    // `--` ids are the per-flavor products behind a printed line, not rows.
    if (product.categoryId !== categoryId || listed.has(product.id) || product.id.includes("--")) continue;
    items.push(overlay({ id: product.id, name: product.name, price: product.price }, product));
  }
  return items;
}

/** The menu page a dashboard-created category belongs on; the first page when it names none. */
function homeGroup(group: string | undefined): string {
  return MENU_GROUPS.some((entry) => entry.id === group) ? group! : MENU_GROUPS[0].id;
}

export function withLiveCatalogue(group: MenuGroup, live: LiveMenu | null): MenuGroup {
  if (!live) return group;
  const categories: MenuCategory[] = [];
  for (const category of group.categories) {
    const stored = live.categories.get(category.id);
    // Absent from the public menu means an admin hid the category.
    if (!stored) continue;
    const items = liveItems(live, category.id, category.items);
    if (items.length) {
      categories.push({
        ...category,
        name: stored.name || category.name,
        nameAr: stored.nameAr || category.nameAr,
        items,
      });
    }
  }
  // Categories created in the dashboard. They are on no printed sheet, so no
  // group's plan names them; before this they, and every product filed under
  // them, never reached the page. Each goes on the page chosen for it, after
  // the printed ones, in the order the dashboard sorts them.
  for (const [id, stored] of live.categories) {
    if (GROUP_BY_CATEGORY_ID.has(id) || homeGroup(stored.group) !== group.id) continue;
    const items = liveItems(live, id, []);
    if (items.length) {
      categories.push({ id, name: stored.name, nameAr: stored.nameAr ?? "", original: stored.name, items });
    }
  }
  return { ...group, categories };
}
