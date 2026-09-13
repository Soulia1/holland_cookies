import { useEffect, useState } from "react";
import { api, type ApiProduct } from "@/lib/api";
import type { MenuCategory, MenuGroup, MenuItem } from "@/data/menu";

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
  categories: ReadonlyMap<string, { name: string; nameAr?: string }>;
}

let pending: Promise<LiveMenu | null> | null = null;

function load(): Promise<LiveMenu | null> {
  pending ??= api.menu().then(
    ({ categories }) => ({
      products: new Map(categories.flatMap((c) => c.items.map((p) => [p.id, p] as const))),
      categories: new Map(categories.map((c) => [c.id, { name: c.name, nameAr: c.nameAr }])),
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

export function withLiveCatalogue(group: MenuGroup, live: LiveMenu | null): MenuGroup {
  if (!live) return group;
  const categories: MenuCategory[] = [];
  for (const category of group.categories) {
    const stored = live.categories.get(category.id);
    // Absent from the public menu means an admin hid the category.
    if (!stored) continue;
    const listed = new Set(category.items.map((item) => item.id));
    const items: MenuItem[] = [];
    for (const item of category.items) {
      const product = live.products.get(item.id);
      if (product) items.push(overlay(item, product));
    }
    for (const product of live.products.values()) {
      // `--` ids are the per-flavor products behind a printed line, not rows.
      if (product.categoryId !== category.id || listed.has(product.id) || product.id.includes("--")) continue;
      items.push(overlay({ id: product.id, name: product.name, price: product.price }, product));
    }
    if (items.length) {
      categories.push({
        ...category,
        name: stored.name || category.name,
        nameAr: stored.nameAr || category.nameAr,
        items,
      });
    }
  }
  return { ...group, categories };
}
