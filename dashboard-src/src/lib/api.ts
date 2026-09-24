/**
 * The dashboard's data layer.
 *
 * This file is an **adapter**, and that is the whole design. Every component
 * and page in this dashboard was copied from Scooby verbatim, so they expect
 * Scooby's API surface exactly: `ordersApi.list(page, pageSize, query, …)`,
 * an order with `orderId` and a flat `total`, an `OrderStats` with a dense
 * daily series. Holland's backend speaks a slightly different dialect —
 * `reference`, a nested `totals`, its own paging parameters.
 *
 * Rather than editing several thousand lines of proven UI to match, the
 * translation happens here, once. The rule for anyone changing this: the
 * exported shapes belong to the components and must not drift; the fetches
 * belong to Holland's backend and may change freely.
 *
 * Where Holland genuinely has no equivalent — transactional mail, online
 * payment — the adapter offers no call at all rather than one that pretends.
 */

export type { OrderStatus, FulfillmentType } from "@shared/orderStatus.mjs";
import type { OrderStatus, FulfillmentType } from "@shared/orderStatus.mjs";
import {
  buildOrderSearchIndex, payloadSearchShape, queryOrders, type OrderSearchIndex,
} from "@shared/orderSearch.mjs";
import { clearSaved, loadSaved, remove, save } from "@/lib/persist";

// ------------------------------------------------------------------ types ---
// Scooby's contract, restated. Fields Holland cannot populate are optional and
// simply absent, which is how the copied components already handle a legacy
// order that predates a field.

export interface OrderItem {
  name: string;
  price: number;
  regularPrice?: number;
  qty: number;
  emoji?: string;
  type?: string;
  /** The option the customer picked, for a product with options. */
  choice?: string;
  selections?: { productId: string; name: string; quantity: number }[];
  components?: {
    productId: string; name: string; quantityPerBundle: number; totalQuantity: number;
  }[];
}

export interface Order {
  id: string;
  orderId: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  area: string;
  fulfillmentType?: FulfillmentType;
  statusUpdatedAt?: string;
  deliveryFee?: number;
  paymentMethod: string;
  /** Cash on delivery only: whether staff have recorded the cash as collected. */
  paymentStatus?: "unpaid" | "paid" | "refunded";
  items: OrderItem[];
  total: number;
  status: OrderStatus;
  createdAt: string;
}

export interface StatusHistoryEntry {
  id: string;
  previousStatus: string;
  newStatus: string;
  changedBy: string;
  note: string;
  createdAt: string;
}

export interface OrderDetail extends Order {
  /** What the customer wrote under "Notes for the kitchen" at checkout. */
  notes?: string;
  subtotal?: number;
  discount?: number;
  promoCode?: string;
  updatedAt?: string;
  statusHistory?: StatusHistoryEntry[];
}

export interface OrderFilters {
  status?: OrderStatus | "";
  fulfillmentType?: FulfillmentType | "";
}

export interface OrderStats {
  totals: {
    orderValue: number; paidRevenue: number; fulfilledRevenue: number;
    cancelledValue: number; liveValue: number; pendingValue: number;
    refundDueValue: number; count: number; averageOrderValue: number;
  };
  byStatus: Record<string, number>;
  byPaymentStatus: Record<string, number>;
  byFulfillment: { delivery: number; pickup: number };
  byArea: { area: string; count: number }[];
  topProducts: { name: string; quantity: number; value: number }[];
  daily: { date: string; orders: number; orderValue: number; paidRevenue: number }[];
  days: number;
  orderCount: number;
}

export interface OrdersPage {
  orders: Order[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export interface MenuItem {
  id: string;
  name: string;
  nameAr?: string;
  /**
   * The REGULAR price. What the customer pays is `effectivePrice(item)` from
   * @shared/productPricing.mjs — this unless a discount is on.
   */
  price: number;
  discountEnabled?: boolean;
  discountType?: "percent" | "fixed";
  discountValue?: number;
  emoji?: string;
  image?: string;
  unit?: string;
  category?: string;
  description?: string;
  descriptionAr?: string;
  note?: string;
  noteAr?: string;
  order?: number;
  slug?: string;
  isAvailable?: boolean;
  createdAt?: string;
  /** A product made of other products: fixed contents, or the customer's choice. */
  isBundle?: boolean;
  bundleType?: "choice" | "fixed";
  bundleSize?: number;
  bundleCategory?: string;
  components?: { productId: string; name?: string; quantity: number }[];
  groups?: BundleGroup[];
  /** Options the customer picks exactly one of before adding it, and what each adds to the price. */
  choices?: ProductOption[];
}

/** One option of a product, and what picking it adds to the product's price. */
export interface ProductOption {
  name: string;
  nameAr?: string;
  priceDelta?: number;
}

export interface BundleGroup {
  label: string;
  labelAr?: string;
  choose: number;
  allowRepeats?: boolean;
  options: { productId: string; name?: string; surcharge?: number }[];
}

/** The product as Holland's API actually returns it. */
interface HollandProduct {
  id: string;
  categoryId: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  note?: string;
  noteAr?: string;
  image?: string;
  price: number;
  regularPrice: number;
  discounted: boolean;
  available: boolean;
  discountEnabled: boolean;
  discountType: "percent" | "fixed";
  discountValue: number;
  sort: number;
  isBundle: boolean;
  bundleType: "fixed" | "choice";
  components: { productId: string; name: string; quantity: number }[];
  groups: BundleGroup[];
  choices?: ProductOption[];
}

function toMenuItem(product: HollandProduct): MenuItem {
  return {
    id: product.id,
    name: product.name,
    nameAr: product.nameAr,
    // The regular price, never the discounted one: the editor subtracts the
    // discount itself, and handing it the sale price would discount twice.
    price: product.regularPrice,
    discountEnabled: product.discountEnabled,
    discountType: product.discountType,
    discountValue: product.discountValue,
    image: product.image,
    category: product.categoryId,
    description: product.description,
    descriptionAr: product.descriptionAr,
    note: product.note,
    noteAr: product.noteAr,
    order: product.sort,
    isAvailable: product.available,
    isBundle: product.isBundle,
    bundleType: product.bundleType,
    components: product.components ?? [],
    groups: product.groups ?? [],
    choices: product.choices ?? [],
  };
}

/** The reverse, for a create or a save. */
function fromMenuItem(item: Partial<MenuItem>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const copy = (from: keyof MenuItem, to = from as string) => {
    if (item[from] !== undefined) body[to] = item[from];
  };
  copy("name"); copy("nameAr");
  copy("description"); copy("descriptionAr");
  copy("note"); copy("noteAr");
  copy("price"); copy("image");
  copy("discountEnabled"); copy("discountType"); copy("discountValue");
  copy("category", "categoryId");
  copy("order", "sort");
  if (item.isAvailable !== undefined) body.available = item.isAvailable;
  copy("isBundle"); copy("bundleType");
  if (item.choices !== undefined) {
    body.choices = item.choices.map(({ name, nameAr, priceDelta }) => ({
      name, nameAr: nameAr ?? "", priceDelta: Number(priceDelta) || 0,
    }));
  }
  if (item.components !== undefined) {
    body.components = item.components.map(({ productId, quantity }) => ({ productId, quantity }));
  }
  if (item.groups !== undefined) {
    body.groups = item.groups.map((group) => ({
      label: group.label,
      labelAr: group.labelAr ?? "",
      choose: group.choose,
      allowRepeats: !!group.allowRepeats,
      options: group.options.map(({ productId, surcharge }) => ({ productId, surcharge: surcharge ?? 0 })),
    }));
  }
  return body;
}

export interface Promo {
  /**
   * Holland's primary key for a code IS the code — there is no separate id.
   * The field is kept because the copied page uses it as a React key and as
   * the argument to update and delete, and it is simply the code again.
   */
  id: string;
  code: string;
  type: "percent" | "fixed";
  value: number;
  minSubtotal?: number;
  maxUses?: number;
  usedCount?: number;
  active: boolean;
  expiresAt?: string;
  createdAt?: string;
}

export interface UserOrderSummary {
  id: string;
  orderId: string;
  total: number;
  status: OrderStatus;
  paymentStatus: string;
  fulfillmentType: FulfillmentType;
  fulfillmentDate: string | null;
  area: string;
  itemCount: number;
  createdAt: string | null;
}

export interface UserRecord {
  key: string;
  /** Always "" here: Holland has no accounts, so there is no profile document. */
  id: string;
  email: string;
  name: string;
  phone: string;
  hasAccount: boolean;
  accountCreatedAt: string | null;
  defaultArea: string;
  orderCount: number;
  /** Non-cancelled order value — what this customer is actually worth. */
  totalSpent: number;
  cancelledValue: number;
  paidValue: number;
  cancelledCount: number;
  averageOrderValue: number;
  firstOrderAt: string | null;
  lastOrderAt: string | null;
  orders: UserOrderSummary[];
  /** Orders beyond the embedded cap. Counts and totals still cover them. */
  truncatedOrders: number;
}

export interface UserDirectory {
  users: UserRecord[];
  totals: {
    users: number;
    withAccount: number;
    guests: number;
    repeatCustomers: number;
    neverOrdered: number;
    orderValue: number;
    anonymousOrders: number;
  };
}

/**
 * The shop settings the server actually stores and enforces. Nothing else is
 * editable: a field the server would discard has no place on the page.
 */
/** One delivery area. `id` is what orders store, so renaming is safe and re-iding is not. */
export interface DeliveryArea {
  id: string;
  name: string;
  nameAr?: string;
  /** The governorate, which checkout groups the select by. */
  city?: string;
  cityAr?: string;
  /**
   * What delivery to this area costs. `null` means the shop's default fee, and
   * 0 means free — they are different things, so this is never coerced.
   */
  fee?: number | null;
}

export interface ShopSettings {
  deliveryFee: number;
  /** 0 means delivery is never free. */
  freeDeliveryOver: number;
  acceptingOrders: boolean;
  areas: DeliveryArea[];
  /** Read-only: whether the server has an email provider switched on. */
  emailEnabled?: boolean;
}

// -------------------------------------------------------------- the cache ---

/**
 * The last answer to each read, kept in memory for this tab.
 *
 * Stale-while-revalidate: a page opens on what it showed last time — no
 * spinner, no blank table — and the fresh request it always makes replaces it
 * a moment later. That is what makes moving between pages, paging back, and
 * backspacing through a search feel instant. Nothing here is ever the final
 * word: every read still goes to the server.
 *
 * A write clears what it affects before it is sent, so a page never opens on a
 * figure the operator has just changed. Signing out, or losing the session,
 * clears everything.
 */
const remembered = new Map<string, unknown>();
const REMEMBER_LIMIT = 80;

function keep<T>(key: string, value: T): T {
  remembered.delete(key);
  remembered.set(key, value);
  save(key, value);
  if (remembered.size > REMEMBER_LIMIT) {
    const oldest = remembered.keys().next().value as string;
    remembered.delete(oldest);
    remove(oldest);
  }
  return value;
}

function recall<T>(key: string): T | undefined {
  return remembered.get(key) as T | undefined;
}

function forget(...prefixes: string[]): void {
  for (const key of [...remembered.keys()]) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      remembered.delete(key);
      remove(key);
    }
  }
}

/** Everything, here and on disk: sign-out, or the session is gone. */
function forgetAll(): void {
  remembered.clear();
  book = null;
  clearSaved();
}

/**
 * Put back what the last visit saved, so the first page drawn after a reload
 * is the one the operator left rather than a spinner. The session gate calls
 * this while it asks whether there is a session, and waits for both; it calls
 * `forgetSaved` if the answer is no.
 *
 * A value already fetched during this visit is newer than the saved one and wins.
 */
export async function restoreSaved(): Promise<void> {
  const saved = await loadSaved();
  for (const [key, value] of saved) {
    if (key !== BOOK_KEY && !remembered.has(key)) remembered.set(key, value);
  }
  const savedBook = saved.get(BOOK_KEY) as SavedBook | undefined;
  if (savedBook && !book) {
    // Area names from the saved settings, so rows do not flash their ids.
    const settings = recall<ShopSettings>("settings");
    adoptBook(savedBook, new Map(settings?.areas.map((area) => [area.id, area.name]) ?? []));
  }
}

/** No session: nothing saved on this device may outlive it. */
export function forgetSaved(): void {
  forgetAll();
}

/** Everything an order write can change the answer to. */
const forgetOrders = () => forget("orders?", "order:", "stats:", "users");

// --------------------------------------------------------- the order book ---

/**
 * The newest orders, whole, held in the browser (`GET /api/orders/book`).
 *
 * With it the Orders page searches, filters and pages without a request: a
 * keystroke is a pass over memory with the same `queryOrders` the server runs,
 * so the answer is the one the server would give, a frame after typing.
 *
 * It is revalidated with its ETag, so keeping it current costs a bodiless 304
 * while nothing has changed. `complete` is false only when the shop has more
 * orders than the server sends; the page then still asks the server, and shows
 * the local answer only until the server's arrives.
 */
export interface OrderBook {
  orders: Order[];
  total: number;
  complete: boolean;
}

interface BookEntry {
  order: Order;
  raw: HollandOrder;
  status: string;
  fulfilment: string;
}

interface SavedBook {
  tag: string | null;
  orders: HollandOrder[];
  total: number;
  complete: boolean;
}

const BOOK_KEY = "book";

let book: (OrderBook & { tag: string | null; entries: BookEntry[] }) | null = null;
let bookLoading: Promise<OrderBook> | null = null;
const bookListeners = new Set<(book: OrderBook) => void>();
const searchIndexes = new WeakMap<HollandOrder, OrderSearchIndex>();

/** Keyed on the raw order, which is replaced when it changes, so an index is built once per version. */
function indexOf(entry: BookEntry): OrderSearchIndex {
  let index = searchIndexes.get(entry.raw);
  if (!index) {
    index = buildOrderSearchIndex(payloadSearchShape(entry.raw));
    searchIndexes.set(entry.raw, index);
  }
  return index;
}

function adoptBook(saved: SavedBook, areas: Map<string, string> = new Map()): void {
  const entries = saved.orders.map((raw) => ({
    order: toOrder(raw, areas), raw, status: raw.status, fulfilment: raw.fulfilment,
  }));
  book = {
    tag: saved.tag,
    entries,
    orders: entries.map((entry) => entry.order),
    total: saved.total,
    complete: saved.complete,
  };
  for (const listener of bookListeners) listener(book);
}

/**
 * Change one order in the book the moment the server has accepted the change —
 * or, with no reference, re-read every row's area name after the areas changed.
 */
function patchBook(reference: string | null, change: (raw: HollandOrder) => HollandOrder): void {
  const current = book;
  if (!current) return;
  void areaNames().then((areas) => {
    if (book !== current) return;
    adoptBook({
      // No longer the server's exact answer: the next revalidation must be a full one.
      tag: null,
      orders: current.entries.map((entry) => (reference === null || entry.raw.reference === reference ? change(entry.raw) : entry.raw)),
      total: current.total,
      complete: current.complete,
    }, areas);
  });
}

/**
 * Revalidate the order book. Concurrent callers share one request; an unchanged
 * book is a 304 and the held copy is returned as it is.
 */
function loadBook(): Promise<OrderBook> {
  bookLoading ??= (async () => {
    const held = book;
    const response = await apiFetch("/api/orders/book", {
      headers: held?.tag ? { "If-None-Match": held.tag } : {},
    });
    if (response.status === 304 && held && book === held) return held;
    const [body, areas] = await Promise.all([
      json<{ orders: HollandOrder[]; total: number; complete: boolean }>(response, "load orders"),
      areaNames(),
    ]);
    const saved: SavedBook = {
      tag: response.headers.get("ETag"),
      orders: body.orders,
      total: body.total,
      complete: body.complete,
    };
    adoptBook(saved, areas);
    save(BOOK_KEY, saved);
    return book!;
  })().finally(() => {
    bookLoading = null;
  });
  return bookLoading;
}

/** The overview's default window, which is what hovering its link prefetches. */
const OVERVIEW_DAYS = 30;

const prefetchedAt = new Map<string, number>();

/**
 * Warm the cache for a page before it is opened: hover, focus or touch on its
 * link. At most once every few seconds per page, so running a pointer up and
 * down the sidebar is not a burst of requests.
 */
export function prefetch(href: string): void {
  const now = Date.now();
  if (now - (prefetchedAt.get(href) ?? 0) < 5000) return;
  prefetchedAt.set(href, now);
  const quietly = (work: Promise<unknown>) => { work.catch(() => {}); };
  switch (href) {
    case "/": quietly(ordersApi.stats(OVERVIEW_DAYS * 2, OVERVIEW_DAYS)); quietly(ordersApi.list(1, 8)); break;
    case "/orders": quietly(ordersApi.book()); break;
    case "/users": quietly(usersApi.list()); break;
    case "/menu": quietly(menuApi.list()); quietly(menuApi.categories()); break;
    case "/promos": quietly(promosApi.list()); break;
  }
}

// ------------------------------------------------------------- the fetches ---

/** Called when a request comes back 401, so the gate can re-appear. */
let sessionLost: (() => void) | null = null;

export function setSessionLostHandler(handler: (() => void) | null): void {
  sessionLost = handler;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      // The admin session is an httpOnly cookie: nothing here holds a credential.
      credentials: "include",
      ...init,
      headers: {
        "X-Requested-With": "Holland",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    // An abort is the caller replacing its own request and must stay an abort.
    if (init.signal?.aborted) throw error;
    // Otherwise the request never reached the server. The browser's wording
    // ("Failed to fetch", "Load failed") would be shown as if it were a reason.
    throw new Error("Could not reach the server. Check the connection and try again.", { cause: error });
  }
  if (response.status === 401) {
    forgetAll();
    sessionLost?.();
  }
  return response;
}

/** Form labels for the fields the server names in a validation failure. */
const FIELD_LABELS: Record<string, string> = {
  id: "Product id", categoryId: "Category", name: "Name (English)", nameAr: "Name (Arabic)",
  description: "Description", descriptionAr: "Description (Arabic)", note: "Note", noteAr: "Note (Arabic)",
  price: "Price", image: "Photo", discountValue: "Discount", group: "Menu section",
  code: "Code", value: "Discount value", minSubtotal: "Minimum order", maxUses: "Max uses",
  expiresAt: "Expiry", deliveryFee: "Delivery fee", freeDeliveryOver: "Free delivery over",
};

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let message = `Failed to ${what}.`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
      // A 400 carries which field failed and why. "Check the fields." alone
      // told the operator nothing, so a product with a bad id was refused
      // silently and never reached the shop.
      const detail = Array.isArray(body?.details) ? body.details[0] : null;
      if (detail?.message) {
        const field = String(detail.path?.[0] ?? "");
        message = `${FIELD_LABELS[field] ?? (field || "A field")}: ${detail.message}`;
      }
    } catch { /* a non-JSON error body; the generic message stands */ }
    throw new Error(message);
  }
  return response.json();
}

/** A permanent id from a display name: lowercase letters, numbers and hyphens. */
export function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 72);
}

export async function hasValidSession(): Promise<boolean> {
  try {
    const response = await apiFetch("/api/admin/session");
    if (!response.ok) return false;
    return (await response.json()).signedIn === true;
  } catch {
    return false;
  }
}

export async function signIn(key: string): Promise<void> {
  const response = await apiFetch("/api/admin/session", {
    method: "POST",
    body: JSON.stringify({ key }),
  });
  if (!response.ok) throw new Error("That key was not accepted.");
}

export async function signOut(): Promise<void> {
  forgetAll();
  await apiFetch("/api/admin/session", { method: "DELETE" }).catch(() => {});
}

// ------------------------------------------------------------- translation ---

interface HollandOrder {
  reference: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  fulfilment: "delivery" | "pickup";
  createdAt: string;
  customer: { firstName: string; lastName: string; phone: string; email: string };
  delivery: {
    area: string; address: string; building: string;
    floor: string; apartment: string; landmark: string; notes: string;
  };
  items: {
    productId: string; name: string; nameAr?: string; note?: string;
    unitPrice: number; qty: number; lineTotal: number;
    choice?: { name: string; nameAr?: string };
    selections?: { group: number; label: string; productId: string; name: string; quantity: number }[];
    components?: { productId: string; name: string; quantity: number }[];
  }[];
  totals: { subtotal: number; discount: number; delivery: number; total: number };
  promoCode?: string;
}

/**
 * The address, as one line.
 *
 * Holland stores building, floor and apartment separately because the checkout
 * asks for them separately; the dashboard shows one address string. Assembled
 * here rather than in the view so the order detail and the printed list agree.
 */
function addressOf(order: HollandOrder): string {
  return [
    order.delivery.address,
    order.delivery.building && `Building ${order.delivery.building}`,
    order.delivery.floor && `Floor ${order.delivery.floor}`,
    order.delivery.apartment && `Apt ${order.delivery.apartment}`,
    order.delivery.landmark,
  ].filter(Boolean).join(", ");
}

/**
 * A timestamp the dates on every page can parse.
 *
 * The API speaks ISO 8601 (`2026-09-15T10:30:00.000Z`) since the Firestore
 * migration. The SQLite build stamped `YYYY-MM-DD HH:MM:SS` in UTC with no
 * marker, and this used to append a `Z` unconditionally — which turned every
 * real ISO timestamp into `…ZZ` and every date in the dashboard into
 * "Invalid Date". The old shape is still accepted; a stamp that already carries
 * its time zone is passed through untouched.
 */
function isoOf(stamp: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(stamp)) return `${stamp.replace(" ", "T")}Z`;
  return stamp;
}

/**
 * Delivery area names by id.
 *
 * Orders store the area's id (`nasr-city`), which is what the dashboard used to
 * print. Read once from the settings the checkout offered them from; an id no
 * longer in the list, or a failed read, still shows as the id.
 */
let areaNamesPending: Promise<Map<string, string>> | null = null;

function areaNames(): Promise<Map<string, string>> {
  areaNamesPending ??= settingsApi.get().then(
    (settings) => new Map(settings.areas.map((area) => [area.id, area.name])),
    () => {
      areaNamesPending = null;
      return new Map();
    },
  );
  return areaNamesPending;
}

function toOrder(order: HollandOrder, areas: Map<string, string> = new Map()): OrderDetail {
  const name = `${order.customer.firstName} ${order.customer.lastName}`.trim();
  return {
    id: order.reference,
    orderId: order.reference,
    name,
    phone: order.customer.phone,
    email: order.customer.email || undefined,
    address: order.fulfilment === "delivery" ? addressOf(order) : undefined,
    area: areas.get(order.delivery.area) ?? (order.delivery.area || ""),
    fulfillmentType: order.fulfilment,
    deliveryFee: order.totals.delivery,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus as Order["paymentStatus"],
    items: order.items.map((item) => ({
      name: item.name,
      price: item.unitPrice,
      qty: item.qty,
      ...(item.choice?.name ? { choice: item.choice.name } : {}),
      ...(item.selections?.length ? {
        selections: item.selections.map((pick) => ({
          productId: pick.productId, name: pick.name, quantity: pick.quantity,
        })),
      } : {}),
      ...(item.components?.length ? {
        components: item.components.map((component) => ({
          productId: component.productId,
          name: component.name,
          quantityPerBundle: component.quantity,
          totalQuantity: component.quantity * item.qty,
        })),
      } : {}),
    })),
    total: order.totals.total,
    subtotal: order.totals.subtotal,
    discount: order.totals.discount,
    notes: order.delivery.notes || undefined,
    promoCode: order.promoCode,
    status: order.status as OrderStatus,
    createdAt: isoOf(order.createdAt),
  };
}

// -------------------------------------------------------------------- apis ---

/** The list's query string: also its key in the cache. */
function listQuery(page: number, pageSize: number, query: string, filters: OrderFilters): URLSearchParams {
  const search = new URLSearchParams({
    page: String(page),
    perPage: String(pageSize),
  });
  if (query) search.set("q", query);
  if (filters.status) search.set("status", filters.status);
  // Both filters are applied by the server's query. Filtering a page after it
  // arrives would leave the page short and the total counting everything.
  if (filters.fulfillmentType) search.set("fulfilment", filters.fulfillmentType);
  return search;
}

export const ordersApi = {
  /** `topDays`: how many of the latest `days` best sellers and areas cover. */
  async stats(days = 30, topDays = days): Promise<OrderStats> {
    return keep(`stats:${days}:${topDays}`,
      await json<OrderStats>(await apiFetch(`/api/orders/stats?days=${days}&topDays=${topDays}`), "load statistics"));
  },

  /** What `stats` last returned for these arguments, if anything. */
  peekStats(days = 30, topDays = days): OrderStats | undefined {
    return recall(`stats:${days}:${topDays}`);
  },

  /**
   * Positional arguments, because that is the signature the copied pages call.
   * `signal` is what lets live search abort a request for a query the operator
   * has already typed past.
   */
  async list(
    page = 1,
    pageSize = 25,
    query = "",
    filters: OrderFilters = {},
    signal?: AbortSignal,
  ): Promise<OrdersPage> {
    const search = listQuery(page, pageSize, query, filters);

    const [body, areas] = await Promise.all([
      json<{
        orders: HollandOrder[]; page: number; perPage: number; total: number; pages: number;
      }>(await apiFetch(`/api/orders?${search}`, { signal }), "load orders"),
      areaNames(),
    ]);

    return keep(`orders?${search}`, {
      orders: body.orders.map((order) => toOrder(order, areas)),
      page: body.page,
      pageSize: body.perPage,
      total: body.total,
      totalPages: body.pages,
      hasMore: body.page < body.pages,
    });
  },

  /** What `list` last returned for exactly these arguments, if anything. */
  peekList(page = 1, pageSize = 25, query = "", filters: OrderFilters = {}): OrdersPage | undefined {
    return recall(`orders?${listQuery(page, pageSize, query, filters)}`);
  },

  /** Revalidate the order book: a 304 when nothing has changed. */
  book(): Promise<OrderBook> {
    return loadBook();
  },

  /** Called with the book whenever it changes. Returns the unsubscribe. */
  onBook(listener: (book: OrderBook) => void): () => void {
    bookListeners.add(listener);
    return () => { bookListeners.delete(listener); };
  },

  /**
   * One page of the list, answered from the order book with no request: the
   * same filtering, ranking and paging as `list`, because it is the same
   * `queryOrders` the server runs. Undefined until the book has loaded.
   */
  localList(page = 1, pageSize = 25, query = "", filters: OrderFilters = {}): (OrdersPage & { complete: boolean }) | undefined {
    if (!book) return undefined;
    const result = queryOrders(book.entries, {
      page,
      perPage: pageSize,
      q: query,
      status: filters.status || null,
      fulfilment: filters.fulfillmentType || null,
    }, indexOf);
    return {
      orders: result.rows.map((entry) => entry.order),
      page,
      pageSize,
      total: result.total,
      totalPages: result.pages,
      hasMore: page < result.pages,
      complete: book.complete,
    };
  },

  async get(reference: string): Promise<OrderDetail> {
    const [body, areas] = await Promise.all([
      json<{
        order: HollandOrder;
        history: { status: string; note: string; created_at: string }[];
      }>(await apiFetch(`/api/orders/${encodeURIComponent(reference)}`), "load the order"),
      areaNames(),
    ]);

    const order = toOrder(body.order, areas);
    // The history is a flat list of states; the view wants transitions, so the
    // previous state is the one before it in the same list.
    order.statusHistory = body.history.map((entry, index) => ({
      id: String(index),
      previousStatus: index > 0 ? body.history[index - 1].status : "",
      newStatus: entry.status,
      changedBy: "admin",
      note: entry.note,
      createdAt: isoOf(entry.created_at),
    }));
    return keep(`order:${reference}`, order);
  },

  peekOrder(reference: string): OrderDetail | undefined {
    return recall(`order:${reference}`);
  },

  /**
   * Record whether the cash for a completed order was collected.
   *
   * Cash on delivery is the only payment method, so this is staff bookkeeping —
   * no payment provider exists and nothing here implies one.
   */
  async updatePayment(reference: string, paymentStatus: "paid" | "unpaid"): Promise<void> {
    forgetOrders();
    const response = await apiFetch(`/api/orders/${encodeURIComponent(reference)}/payment`, {
      method: "PATCH",
      body: JSON.stringify({ paymentStatus }),
    });
    await json(response, "record the cash collection");
    patchBook(reference, (raw) => ({ ...raw, paymentStatus }));
  },

  async updateStatus(reference: string, status: OrderStatus, note = ""): Promise<void> {
    forgetOrders();
    const response = await apiFetch(`/api/orders/${encodeURIComponent(reference)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    });
    await json(response, "update the status");
    patchBook(reference, (raw) => ({ ...raw, status }));
  },
};

export const menuApi = {
  async list(): Promise<MenuItem[]> {
    const body = await json<{ products: HollandProduct[] }>(
      await apiFetch("/api/menu/admin/products"), "load the menu",
    );
    return keep("menu:products", body.products.map(toMenuItem));
  },

  peek(): MenuItem[] | undefined {
    return recall("menu:products");
  },

  peekCategories(): { id: string; name: string; nameAr: string; group: string }[] | undefined {
    return recall("menu:categories");
  },

  async categories(): Promise<{ id: string; name: string; nameAr: string; group: string }[]> {
    return keep("menu:categories", (await json<{ categories: { id: string; name: string; nameAr: string; group: string }[] }>(
      await apiFetch("/api/menu/admin/categories"), "load categories",
    )).categories);
  },

  async create(item: Partial<MenuItem>): Promise<MenuItem> {
    forget("menu:");
    // The id is required by the server and is permanent — cart lines and past
    // orders key on it. Made from the English name when the form left it blank,
    // and cleaned either way, so "Pistachio Cookie" files as pistachio-cookie
    // instead of being refused. A name with no Latin letters still gets one.
    const typed = slugify(item.id ?? "");
    const base = typed || slugify(item.name ?? "") || `item-${Date.now().toString(36)}`;
    // A derived id that is already taken gets a number rather than an error:
    // two products can share a name. An id typed by hand is never renumbered.
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const id = attempt === 1 ? base : `${base}-${attempt}`;
      const response = await apiFetch("/api/menu/admin/products", {
        method: "POST",
        body: JSON.stringify({ id, ...fromMenuItem(item) }),
      });
      if (response.status === 409 && !typed) continue;
      const body = await json<{ product: HollandProduct }>(response, "create the product");
      return toMenuItem(body.product);
    }
    throw new Error("Every id made from this name is taken. Type a product id.");
  },

  async update(id: string, patch: Partial<MenuItem>): Promise<MenuItem> {
    forget("menu:");
    const body = await json<{ product: HollandProduct }>(
      await apiFetch(`/api/menu/admin/products/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(fromMenuItem(patch)),
      }),
      "save the product",
    );
    return toMenuItem(body.product);
  },

  async remove(id: string): Promise<void> {
    forget("menu:");
    const response = await apiFetch(`/api/menu/admin/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (response.status === 204) return;
    // Keep the server's reason. In particular, deleting a product that a
    // bundle still uses is a safe, deliberate 409 with instructions for the
    // operator; replacing it with a generic failure made the guard look broken.
    await json(response, "delete the product");
  },

  /** The id is permanent — products key on it — so it is derived from the name once. */
  async createCategory(name: string, nameAr = "", group = "cookies"): Promise<{ id: string; name: string }> {
    forget("menu:");
    const id = slugify(name) || `category-${Date.now().toString(36)}`;
    const body = await json<{ category: { id: string; name: string } }>(
      await apiFetch("/api/menu/admin/categories", {
        method: "POST",
        // `group` is the shop page it appears on. Without it a new category
        // had no place on the storefront at all.
        body: JSON.stringify({ id, name: name.trim(), nameAr: nameAr.trim(), group }),
      }),
      "create the category",
    );
    return body.category;
  },

  /**
   * Delete a category. `withProducts` is opt-in: without it a category holding
   * products is refused. Returns how many products went with it.
   */
  async removeCategory(id: string, withProducts = false): Promise<number> {
    forget("menu:");
    const query = withProducts ? "?withProducts=1" : "";
    const response = await apiFetch(
      `/api/menu/admin/categories/${encodeURIComponent(id)}${query}`,
      { method: "DELETE" },
    );
    if (response.status === 204) return 0;
    const body = await json<{ deletedProducts?: number }>(response, "delete the category");
    return body.deletedProducts ?? 0;
  },
};

export const imagesApi = {
  /** Upload an already-shrunk photo; returns the path to store on the product. */
  async upload(photo: Blob): Promise<string> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Could not read the photo."));
      reader.readAsDataURL(photo);
    });
    const body = await json<{ path: string }>(
      await apiFetch("/api/admin/images", {
        method: "POST",
        body: JSON.stringify({ data: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
      }),
      "upload the photo",
    );
    return body.path;
  },
};

export const promosApi = {
  async list(): Promise<Promo[]> {
    const body = await json<{ promos: Omit<Promo, "id">[] }>(
      await apiFetch("/api/admin/promos"), "load discount codes",
    );
    return keep("promos", body.promos.map((promo) => ({ ...promo, id: promo.code })));
  },
  peek(): Promo[] | undefined {
    return recall("promos");
  },
  async create(promo: Partial<Promo> & { code: string }): Promise<void> {
    forget("promos");
    await json(await apiFetch("/api/admin/promos", {
      method: "POST", body: JSON.stringify(promo),
    }), "create the code");
  },
  async update(code: string, patch: Partial<Promo>): Promise<void> {
    forget("promos");
    await json(await apiFetch(`/api/admin/promos/${encodeURIComponent(code)}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }), "update the code");
  },
  async remove(code: string): Promise<void> {
    forget("promos");
    const response = await apiFetch(`/api/admin/promos/${encodeURIComponent(code)}`, {
      method: "DELETE",
    });
    if (response.status === 204) return;
    await json(response, "delete the code");
  },
};

/**
 * The customer directory.
 *
 * Scooby's "Users" are accounts with a sign-in; Holland has no accounts, and a
 * customer record is created by their first order. The shape is identical, so
 * the page works unchanged — it is listing people who have ordered rather than
 * people who have registered, and `hasAccount` is false throughout.
 */
export const usersApi = {
  async list(refresh = false): Promise<UserDirectory> {
    const [directory, areas] = await Promise.all([
      json<UserDirectory>(
        await apiFetch(`/api/admin/users${refresh ? "?refresh=1" : ""}`),
        "load customers",
      ),
      areaNames(),
    ]);
    const areaName = (id: string) => areas.get(id) ?? id;
    // The backend stamps `YYYY-MM-DD HH:MM:SS` in UTC with no marker; the page
    // formats these with `new Date()`, which would read them as local time.
    const iso = (stamp: string | null) => (stamp ? isoOf(stamp) : null);
    return keep("users", {
      ...directory,
      users: directory.users.map((user) => ({
        ...user,
        defaultArea: areaName(user.defaultArea),
        firstOrderAt: iso(user.firstOrderAt),
        lastOrderAt: iso(user.lastOrderAt),
        orders: user.orders.map((order) => ({
          ...order, area: areaName(order.area), createdAt: iso(order.createdAt),
        })),
      })),
    });
  },

  peek(): UserDirectory | undefined {
    return recall("users");
  },
};

export const settingsApi = {
  async get(): Promise<ShopSettings> {
    const body = await json<{ settings: ShopSettings }>(
      await apiFetch("/api/admin/settings"), "load settings",
    );
    return keep("settings", body.settings);
  },

  peek(): ShopSettings | undefined {
    return recall("settings");
  },

  /** Saves, then reads back — so what the page shows is what was stored. */
  async update(
    patch: Partial<Pick<ShopSettings, "deliveryFee" | "freeDeliveryOver" | "acceptingOrders" | "areas">>,
  ): Promise<ShopSettings> {
    await json(await apiFetch("/api/admin/settings", {
      method: "PATCH", body: JSON.stringify(patch),
    }), "save settings");
    // The id → name map for orders was read from the settings this just
    // replaced. Left cached, an area renamed here would keep printing its old
    // name on every order detail until the page was reloaded.
    areaNamesPending = null;
    // Area names are printed on orders and customers too.
    forget("settings", "orders?", "order:", "users");
    patchBook(null, (raw) => raw);
    return settingsApi.get();
  },
};
