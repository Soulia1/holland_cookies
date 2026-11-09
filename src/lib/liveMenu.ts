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

// Share in-flight reads only; completed responses must not freeze admin changes.
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
  ).finally(() => { pending = null; });
  return pending;
}

export function useLiveMenu(): LiveMenuState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LiveMenuState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      load().then(
        (menu) => { if (active) setState({ status: "ready", menu }); },
        () => {
          if (!active) return;
          setState((previous) => previous.status === "ready" ? previous : {
            status: "error",
            retry: () => {
              setState({ status: "loading" });
              setAttempt((count) => count + 1);
            },
          });
        },
      );
    };
    refresh();
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [attempt]);
  return state;
}

function overlay(item: MenuItem, product: ApiProduct): MenuItem {
  return {
    ...item,
    name: product.name || item.name,
    nameAr: product.nameAr || undefined,
    note: product.note || undefined,
    noteAr: product.noteAr || undefined,
    price: product.price,
    regularPrice: product.regularPrice,
    discounted: product.discounted,
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
  const templates = new Map(printed.map((item) => [item.id, item]));
  // API order is the dashboard's sort order. Match category membership before
  // applying a printed template, so moving a product never duplicates it.
  return [...live.products.values()]
    .filter((product) => product.categoryId === categoryId && !product.id.includes("--"))
    .map((product) => overlay(templates.get(product.id) ?? {
      id: product.id, name: product.name, price: product.price,
    }, product));
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
  const templates = new Map(MENU_GROUPS.flatMap((entry) => entry.categories).map((category) => [category.id, category]));
  const categories: MenuCategory[] = [];
  for (const [id, stored] of live.categories) {
    const template = templates.get(id);
    const page = GROUP_BY_CATEGORY_ID.get(id)?.id ?? homeGroup(stored.group);
    if (page !== group.id) continue;
    const items = liveItems(live, id, template?.items ?? []);
    if (!items.length) continue;
    categories.push({
      ...template, id, name: stored.name || template?.name || "",
      nameAr: stored.nameAr || "", original: template?.original ?? stored.name,
      group: group.id, items,
    });
  }
  return { ...group, categories };
}
