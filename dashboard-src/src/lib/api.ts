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
 * Where Holland genuinely has no equivalent — transactional mail, customer
 * accounts — the adapter says so honestly rather than fabricating data. See
 * `mailApi` at the bottom.
 */

export type { OrderStatus, FulfillmentType } from "@shared/orderStatus.mjs";
import type { OrderStatus, FulfillmentType } from "@shared/orderStatus.mjs";

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
  deliveryTimeSlot?: string;
  fulfillmentType?: FulfillmentType;
  deliveryDate?: string | null;
  fulfillmentDate?: string;
  statusUpdatedAt?: string;
  deliveryFee?: number;
  paymentMethod: string;
  paymentStatus?: "unpaid" | "pending" | "paid" | "failed" | "refunded" | "partially_refunded";
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
  subtotal?: number;
  discount?: number;
  promoCode?: string;
  userId?: string | null;
  updatedAt?: string;
  confirmationEmail?: {
    status: "sent" | "failed";
    provider?: string; providerEmailId?: string; providerStatus?: string;
    errorCode?: string; sentAt?: string; failedAt?: string;
  };
  statusHistory?: StatusHistoryEntry[];
}

export interface OrderFilters {
  status?: OrderStatus | "";
  fulfillmentType?: FulfillmentType | "";
  fulfillmentDate?: string;
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
  hoverImage?: string;
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

export interface Settings {
  store: { name: string; email: string };
  mail: {
    configured: boolean;
    provider: "brevo";
    source: "environment";
    fromName: string; fromEmail: string; replyTo: string;
  };
  fulfillment?: {
    pickupAddress: string;
    pickupHours: string;
    deliveryAreas: string[];
    deliveryFee: number;
    freeDeliveryOver: number;
    acceptingOrders: boolean;
    cutoffHour: number;
    pickupCutoffHour: number;
  };
}

// ------------------------------------------------------------- the fetches ---

/** Called when a request comes back 401, so the gate can re-appear. */
let sessionLost: (() => void) | null = null;

export function setSessionLostHandler(handler: (() => void) | null): void {
  sessionLost = handler;
}

async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    // The admin session is an httpOnly cookie: nothing here holds a credential.
    credentials: "include",
    ...init,
    headers: {
      "X-Requested-With": "Holland",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 401) sessionLost?.();
  return response;
}

async function json<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let message = `Failed to ${what}.`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch { /* a non-JSON error body; the generic message stands */ }
    throw new Error(message);
  }
  return response.json();
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

/** Holland stamps `YYYY-MM-DD HH:MM:SS` in UTC with no marker. */
function isoOf(stamp: string): string {
  return `${stamp.replace(" ", "T")}Z`;
}

function toOrder(order: HollandOrder): OrderDetail {
  const name = `${order.customer.firstName} ${order.customer.lastName}`.trim();
  return {
    id: order.reference,
    orderId: order.reference,
    name,
    phone: order.customer.phone,
    email: order.customer.email || undefined,
    address: order.fulfilment === "delivery" ? addressOf(order) : undefined,
    area: order.delivery.area || "",
    fulfillmentType: order.fulfilment,
    deliveryFee: order.totals.delivery,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus as Order["paymentStatus"],
    items: order.items.map((item) => ({
      name: item.name,
      price: item.unitPrice,
      qty: item.qty,
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
    promoCode: order.promoCode,
    status: order.status as OrderStatus,
    createdAt: isoOf(order.createdAt),
  };
}

// -------------------------------------------------------------------- apis ---

export const ordersApi = {
  async stats(days = 30): Promise<OrderStats> {
    return json(await apiFetch(`/api/orders/stats?days=${days}`), "load statistics");
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
    const search = new URLSearchParams({
      page: String(page),
      perPage: String(pageSize),
    });
    if (query) search.set("q", query);
    if (filters.status) search.set("status", filters.status);

    const body = await json<{
      orders: HollandOrder[]; page: number; perPage: number; total: number; pages: number;
    }>(await apiFetch(`/api/orders?${search}`, { signal }), "load orders");

    let orders = body.orders.map(toOrder);
    // Holland's API does not filter on fulfilment, and adding a parameter for a
    // control the operator uses occasionally is not worth a round trip through
    // the backend. Applied to the page rather than the whole set, which is the
    // honest limitation — the status filter, which matters far more, is done
    // server-side.
    if (filters.fulfillmentType) {
      orders = orders.filter((order) => order.fulfillmentType === filters.fulfillmentType);
    }

    return {
      orders,
      page: body.page,
      pageSize: body.perPage,
      total: body.total,
      totalPages: body.pages,
      hasMore: body.page < body.pages,
    };
  },

  async get(reference: string): Promise<OrderDetail> {
    const body = await json<{
      order: HollandOrder;
      history: { status: string; note: string; created_at: string }[];
    }>(await apiFetch(`/api/orders/${encodeURIComponent(reference)}`), "load the order");

    const order = toOrder(body.order);
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
    return order;
  },

  /**
   * Holland records a payment status but has no gateway to change it, so this
   * is the one write the backend does not accept. It throws rather than
   * resolving, so the control reports a failure instead of appearing to work.
   */
  async updatePayment(_reference: string, _paymentStatus: string): Promise<never> {
    throw new Error("Payment status is set by the payment provider, which is not connected yet.");
  },

  async updateStatus(reference: string, status: OrderStatus, note = ""): Promise<void> {
    const response = await apiFetch(`/api/orders/${encodeURIComponent(reference)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status, note }),
    });
    await json(response, "update the status");
  },
};

export const menuApi = {
  async list(): Promise<MenuItem[]> {
    const body = await json<{ products: HollandProduct[] }>(
      await apiFetch("/api/menu/admin/products"), "load the menu",
    );
    return body.products.map(toMenuItem);
  },

  async categories(): Promise<{ id: string; name: string; nameAr: string }[]> {
    return (await json<{ categories: { id: string; name: string; nameAr: string }[] }>(
      await apiFetch("/api/menu/admin/categories"), "load categories",
    )).categories;
  },

  async create(item: Partial<MenuItem>): Promise<MenuItem> {
    // The id is required by the server and is permanent — cart lines and past
    // orders key on it. Derived from the name when the form did not set one.
    const id = item.id?.trim()
      || (item.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const body = await json<{ product: HollandProduct }>(
      await apiFetch("/api/menu/admin/products", {
        method: "POST",
        body: JSON.stringify({ id, ...fromMenuItem(item) }),
      }),
      "create the product",
    );
    return toMenuItem(body.product);
  },

  async update(id: string, patch: Partial<MenuItem>): Promise<MenuItem> {
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
    const response = await apiFetch(`/api/menu/admin/products/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) throw new Error("Failed to delete the product.");
  },

  /** The id is permanent — products key on it — so it is derived from the name once. */
  async createCategory(name: string, nameAr = ""): Promise<{ id: string; name: string }> {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!id) throw new Error("Give the category an English name using letters or numbers.");
    const body = await json<{ category: { id: string; name: string } }>(
      await apiFetch("/api/menu/admin/categories", {
        method: "POST",
        body: JSON.stringify({ id, name: name.trim(), nameAr: nameAr.trim() }),
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
    return body.promos.map((promo) => ({ ...promo, id: promo.code }));
  },
  async create(promo: Partial<Promo> & { code: string }): Promise<void> {
    await json(await apiFetch("/api/admin/promos", {
      method: "POST", body: JSON.stringify(promo),
    }), "create the code");
  },
  async update(code: string, patch: Partial<Promo>): Promise<void> {
    await json(await apiFetch(`/api/admin/promos/${encodeURIComponent(code)}`, {
      method: "PATCH", body: JSON.stringify(patch),
    }), "update the code");
  },
  async remove(code: string): Promise<void> {
    const response = await apiFetch(`/api/admin/promos/${encodeURIComponent(code)}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 204) throw new Error("Failed to delete the code.");
  },
};

/**
 * Customers.
 *
 * Scooby's "Users" are accounts with a sign-in; Holland has no accounts, and a
 * customer record is created by their first order. The directory shape is the
 * same, so the page works unchanged — it is simply listing people who have
 * ordered rather than people who have registered.
 */
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
    const directory = await json<UserDirectory>(
      await apiFetch(`/api/admin/users${refresh ? "?refresh=1" : ""}`),
      "load customers",
    );
    // The backend stamps `YYYY-MM-DD HH:MM:SS` in UTC with no marker; the page
    // formats these with `new Date()`, which would read them as local time.
    const iso = (stamp: string | null) => (stamp ? isoOf(stamp) : null);
    return {
      ...directory,
      users: directory.users.map((user) => ({
        ...user,
        firstOrderAt: iso(user.firstOrderAt),
        lastOrderAt: iso(user.lastOrderAt),
        orders: user.orders.map((order) => ({ ...order, createdAt: iso(order.createdAt) })),
      })),
    };
  },
};

export const settingsApi = {
  async get(): Promise<Settings> {
    const body = await json<{
      settings: {
        deliveryFee: number; freeDeliveryOver: number; acceptingOrders: boolean;
        areas: { id: string; name: string; nameAr?: string }[];
      };
    }>(await apiFetch("/api/admin/settings"), "load settings");

    return {
      store: { name: "Holland Cookies", email: "" },
      // Reported as unconfigured because it is: there is no mail provider wired
      // to this backend. Saying "configured" here would be a lie the Settings
      // page would then repeat to the operator.
      mail: {
        configured: false, provider: "brevo", source: "environment",
        fromName: "", fromEmail: "", replyTo: "",
      },
      fulfillment: {
        pickupAddress:
          "27/19 Mohamed El-Moqrif St., off Hassan El-Mamoun — next to BIM Market, Nasr City",
        pickupHours: "Daily 11:00 – 01:00",
        deliveryAreas: body.settings.areas.map((area) => area.name),
        deliveryFee: body.settings.deliveryFee,
        freeDeliveryOver: body.settings.freeDeliveryOver,
        acceptingOrders: body.settings.acceptingOrders,
        cutoffHour: 12,
        pickupCutoffHour: 20,
      },
    };
  },

  async update(patch: {
    fulfillment?: Partial<NonNullable<Settings["fulfillment"]>>;
    store?: Settings["store"];
  }): Promise<Settings> {
    if (patch.fulfillment) {
      const body: Record<string, unknown> = {};
      if (patch.fulfillment.deliveryFee !== undefined) {
        body.deliveryFee = patch.fulfillment.deliveryFee;
      }
      if (patch.fulfillment.freeDeliveryOver !== undefined) {
        body.freeDeliveryOver = patch.fulfillment.freeDeliveryOver;
      }
      if (patch.fulfillment.acceptingOrders !== undefined) {
        body.acceptingOrders = patch.fulfillment.acceptingOrders;
      }
      await json(await apiFetch("/api/admin/settings", {
        method: "PATCH", body: JSON.stringify(body),
      }), "save settings");
    }
    return settingsApi.get();
  },
};

/**
 * Mail.
 *
 * Holland has no transactional mail provider. The methods exist so the copied
 * Settings page compiles and renders, and they fail with a message that says
 * exactly that — rather than resolving silently and letting an operator believe
 * a test email went out.
 */
export const mailApi = {
  async verify(): Promise<never> {
    throw new Error("No mail provider is configured for Holland Cookies yet.");
  },
  async test(_to: string): Promise<never> {
    throw new Error("No mail provider is configured for Holland Cookies yet.");
  },
};
