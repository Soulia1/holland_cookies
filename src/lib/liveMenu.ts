import { useEffect, useState } from "react";
import { api, type ApiProduct } from "@/lib/api";
import {
  GROUP_BY_CATEGORY_ID, MENU_GROUPS, leadDaysForCategory,
  type MenuCategory, type MenuGroup, type MenuItem,
} from "@/data/menu";

/**
 * The catalogue as the dashboard last left it.
 *
 * The printed menu in `data/menu.ts` stays the page's structure — groups,
 * order, bundled photos — and this lays the database over it, so a price,
 * name, photo, options, availability or visibility change made in the
 * dashboard reaches the page.
 *
 * The printed products themselves are never shown on their own. They were,
 * while the request was in flight or after it failed, and that put the sheet's
 * old names, prices and flavor options in front of customers — options the
 * dashboard did not have and the server refuses at checkout.
 */
export interface LiveMenu {
  products: ReadonlyMap<string, ApiProduct>;
  /** In the API's order. `group` is the menu page a dashboard-created category is filed under. */
  categories: ReadonlyMap<string, { name: string; nameAr?: string; group?: string }>;
}

export type LiveMenuState =
  | { status: "loading" }
  | { status: "ready"; menu: LiveMenu }
  | { status: "error"; retry: () => void };

// Shared by every page that asks, so moving between menu pages is one request.
// A failure is not kept: the next ask tries again.
let pending: Promise<LiveMenu> | null = null;

function load(): Promise<LiveMenu> {
  pending ??= api.menu().then(
    ({ categories }) => ({
      products: new Map(categories.flatMap((c) => c.items.map((p) => [p.id, p] as const))),
      categories: new Map(categories.map((c) => [c.id, { name: c.name, nameAr: c.nameAr, group: c.group }])),
    }),
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

export function useLiveMenu(): LiveMenuState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LiveMenuState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    load().then(
      (menu) => {
        if (active) setState({ status: "ready", menu });
      },
      () => {
        if (!active) return;
        setState({
          status: "error",
          retry: () => {
            setState({ status: "loading" });
            setAttempt((count) => count + 1);
          },
        });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  return state;
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
    choices: product.choices?.length ? product.choices : undefined,
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
    // `--` ids are per-flavor products an earlier version wrote behind a printed line, not rows.
    if (product.categoryId !== categoryId || listed.has(product.id) || product.id.includes("--")) continue;
    items.push(overlay({ id: product.id, name: product.name, price: product.price }, product));
  }
  return items;
}

/**
 * The working days a product in the cart needs, or 0.
 *
 * Resolved from the live catalogue rather than from a snapshot taken when the
 * line was added: a lead time is a fact about the shop, and a cart that has been
 * sitting in storage since before the shop set one would otherwise promise the
 * customer something the kitchen no longer does.
 */
export function leadDaysForProduct(live: LiveMenu | null, productId: string): number {
  const categoryId = live?.products.get(productId)?.categoryId;
  if (!categoryId) return 0;
  return leadDaysForCategory(categoryId, live?.categories.get(categoryId)?.group);
}

/** The menu page a dashboard-created category belongs on; the first page when it names none. */
function homeGroup(group: string | undefined): string {
  return MENU_GROUPS.some((entry) => entry.id === group) ? group! : MENU_GROUPS[0].id;
}

export function withLiveCatalogue(group: MenuGroup, live: LiveMenu): MenuGroup {
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
        group: group.id,
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
      categories.push({
        id, name: stored.name, nameAr: stored.nameAr ?? "", original: stored.name, group: group.id, items,
      });
    }
  }
  return { ...group, categories };
}
