/**
 * The API client.
 *
 * A thin wrapper over `fetch` whose only real job is turning the server's error
 * shape into something the UI can act on. Every route answers a failure with
 * `{ error, message, fields? }`, and losing that structure — by throwing a bare
 * `Error("Request failed")` — is what forces a form to show one useless banner
 * instead of putting each message under the field it belongs to.
 */

/** Same origin in production; the dev server proxies to the API in development. */
const BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  code: string;
  status: number;
  /** Field-keyed validation messages, when the failure was a form. */
  fields?: Record<string, string>;
  details?: unknown;

  constructor(status: number, code: string, message: string, extra: {
    fields?: Record<string, string>;
    details?: unknown;
  } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = extra.fields;
    this.details = extra.details;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      // The admin session is an httpOnly cookie, so it only travels if this is
      // set. Harmless on the public routes.
      credentials: "include",
      ...init,
      headers: {
        "X-Requested-With": "Holland",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    // A network failure is not a server error, and telling somebody their order
    // was rejected when their wifi dropped is a lie that costs a sale.
    throw new ApiError(0, "NETWORK", "We could not reach the kitchen. Check your connection.");
  }

  if (response.status === 204) return undefined as T;

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body from a route that should always answer JSON means
    // something upstream answered instead — a proxy, a 502 page.
    if (!response.ok) {
      throw new ApiError(response.status, "SERVER_ERROR", "Something went wrong on our end.");
    }
  }

  if (!response.ok) {
    const error = (body ?? {}) as {
      error?: string; message?: string;
      fields?: Record<string, string>; details?: unknown;
    };
    throw new ApiError(
      response.status,
      error.error ?? "SERVER_ERROR",
      error.message ?? "Something went wrong.",
      { fields: error.fields, details: error.details },
    );
  }

  return body as T;
}

// ------------------------------------------------------------------ types ---

export interface ApiProduct {
  id: string;
  categoryId: string;
  name: string;
  nameAr?: string;
  description?: string;
  descriptionAr?: string;
  note?: string;
  noteAr?: string;
  image?: string;
  /** What it costs today, after any discount. */
  price: number;
  /** What it costs without the discount. Equal to `price` when there is none. */
  regularPrice: number;
  discounted: boolean;
  available: boolean;
  isBundle?: boolean;
  bundleType?: "fixed" | "choice";
  components?: { productId: string; name: string; nameAr?: string; quantity: number }[];
  groups?: ApiBundleGroup[];
}

export interface ApiBundleGroup {
  label: string;
  labelAr?: string;
  choose: number;
  allowRepeats: boolean;
  options: {
    productId: string; name: string; nameAr?: string; surcharge: number; available: boolean;
  }[];
}

export interface OrderSelection {
  group: number;
  label?: string;
  labelAr?: string;
  productId: string;
  name: string;
  nameAr?: string;
  quantity: number;
}

export interface ApiCategory {
  id: string;
  name: string;
  nameAr?: string;
  /** The menu page a category created in the dashboard is shown on. */
  group?: string;
  items: ApiProduct[];
}

export interface Settings {
  deliveryFee: number;
  freeDeliveryOver: number;
  acceptingOrders: boolean;
  areas: { id: string; name: string; nameAr?: string }[];
}

export interface OrderTotals {
  subtotal: number;
  discount: number;
  delivery: number;
  total: number;
}

export interface Order {
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
    selections?: OrderSelection[];
    components?: { productId: string; name: string; nameAr?: string; quantity: number }[];
  }[];
  totals: OrderTotals;
  promoCode?: string;
}

export interface StatusEvent {
  status: string;
  note: string;
  created_at: string;
}

export interface Customer {
  id: number;
  email: string;
  fullName: string;
  phone: string;
  defaultArea: string;
  defaultAddress: string;
}

export interface AccountOrder {
  reference: string;
  status: string;
  fulfilment: "delivery" | "pickup";
  createdAt: string;
  totals: OrderTotals;
  items: { name: string; nameAr?: string; qty: number; unitPrice: number; lineTotal: number }[];
}

export interface CheckoutBody {
  idempotencyKey: string;
  items: {
    productId: string;
    qty: number;
    selections?: { group: number; productId: string; quantity: number }[];
  }[];
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  fulfilment: "delivery" | "pickup";
  area?: string;
  address?: string;
  building?: string;
  floor?: string;
  apartment?: string;
  landmark?: string;
  notes?: string;
  promoCode?: string;
  lang?: "en" | "ar";
  /**
   * The total the customer was shown.
   *
   * Sent so the server can *refuse* if the catalogue has moved underneath them.
   * It is never used as the amount — see backend/orderTransaction.js.
   */
  expectedTotal?: number;
}

// ----------------------------------------------------------------- public ---

export const api = {
  menu: () => request<{ categories: ApiCategory[] }>("/api/menu"),

  settings: () => request<{ settings: Settings }>("/api/admin/settings"),

  placeOrder: (body: CheckoutBody) =>
    request<{ order: Order; duplicate: boolean }>("/api/orders", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  trackOrder: (reference: string, phone: string) =>
    request<{ order: Order; history: StatusEvent[] }>(
      `/api/orders/track/${encodeURIComponent(reference)}?phone=${encodeURIComponent(phone)}`,
    ),

  /**
   * Who is signed in, if anyone.
   *
   * Answers for a signed-out visitor too, with `customer: null` — every page
   * asks this on load, and a 401 for the ordinary anonymous case would be noise
   * rather than information.
   */
  me: () => request<{ customer: Customer | null; mailConfigured: boolean }>("/api/account/me"),

  requestCode: (email: string, lang: "en" | "ar") =>
    request<{ ok: true; delivered: boolean; via: string }>("/api/account/request-code", {
      method: "POST",
      body: JSON.stringify({ email, lang }),
    }),

  verifyCode: (email: string, code: string) =>
    request<{ customer: Customer; linkedOrders: number }>("/api/account/verify-code", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    }),

  signOut: () => request<{ ok: true }>("/api/account/signout", { method: "POST" }),

  updateProfile: (
    patch: Partial<Pick<Customer, "fullName" | "phone" | "defaultArea" | "defaultAddress">>,
  ) =>
    request<{ customer: Customer }>("/api/account/profile", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  accountOrders: () => request<{ orders: AccountOrder[] }>("/api/account/orders"),

  validatePromo: (code: string, subtotal: number) =>
    request<{ code: string; discount: number }>("/api/admin/promos/validate", {
      method: "POST",
      body: JSON.stringify({ code, subtotal }),
    }),
};

/**
 * A key that survives a retry but not a new basket.
 *
 * Generated once when the checkout form is first shown and reused for every
 * submit from that form, so a double-tapped Pay button or a request the network
 * ate and the browser retried produces one order rather than two. `randomUUID`
 * where it exists; the fallback is for older WebKit, which is exactly the
 * browser this project cares most about.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, "0")).join("");
}
