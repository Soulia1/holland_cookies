/**
 * The cart, as pure functions.
 *
 * No React, no browser, no storage — every function here takes a cart and
 * returns a new one. That is deliberate and it is the whole reason this file
 * is separate from `cart.tsx`: cart arithmetic is the part of a shop that must
 * not be wrong, and this way it can be tested exhaustively without mounting a
 * component or faking a DOM. `cart.tsx` adds React and localStorage on top and
 * contains no arithmetic of its own.
 *
 * **A cart line stores identity, not money.**
 * `productId` and `qty` are the truth. `name` and `price` are a *display
 * snapshot* — enough to draw the drawer without re-reading the catalogue, and
 * nothing more. When the backend arrives it will re-price every line from
 * `productId` against the catalogue and ignore whatever `price` says here, so a
 * cart edited in DevTools buys nothing at a discount. Writing it this way now
 * means that server can be added without touching this file.
 */

/** Storage key. Versioned: a shape change bumps it rather than trying to migrate. */
export const CART_STORAGE_KEY = "holland-cart-v1";

/**
 * Per-line ceiling. Not a business rule so much as a guard — it stops a stuck
 * key or a leaning finger turning into an order for four hundred cookies, and
 * it bounds anything downstream that multiplies by it.
 */
export const MAX_QTY = 50;

export interface CartItem {
  /** The stable menu id. The only field anything authoritative should trust. */
  productId: string;
  /** Display snapshot: the English name. Re-read from the catalogue to localize. */
  name: string;
  /** Display snapshot in EGP. Presentational — see the note at the top. */
  price: number;
  /** Printed packaging or size, where the item has one. Display only. */
  note?: string;
  qty: number;
}

/** A cart line's identity, for lookups and React keys. */
export function lineKey(item: Pick<CartItem, "productId">): string {
  return item.productId;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampQty(qty: number): number {
  return Math.min(MAX_QTY, Math.max(1, Math.floor(qty)));
}

/**
 * Add to the cart, merging into the existing line if the product is already
 * there. Merging rather than appending is what stops "add" pressed twice from
 * producing two identical rows the customer then has to reconcile.
 *
 * A repeat add also refreshes the display snapshot, so a line that has been
 * sitting in storage since a price change shows the current price the moment
 * the customer touches it again.
 */
export function addItem(
  items: CartItem[],
  item: Omit<CartItem, "qty">,
  qty = 1,
): CartItem[] {
  const key = lineKey(item);
  const existing = items.find((line) => lineKey(line) === key);
  if (!existing) return [...items, { ...item, qty: clampQty(qty) }];
  return items.map((line) =>
    lineKey(line) === key
      ? { ...line, ...item, qty: clampQty(line.qty + qty) }
      : line,
  );
}

/**
 * Nudge a line's quantity. Reaching zero removes the line, so the stepper's
 * minus button doubles as "remove" at the bottom of its range and there is no
 * separate empty-line state to render.
 */
export function changeQty(items: CartItem[], key: string, delta: number): CartItem[] {
  return items.flatMap((line) => {
    if (lineKey(line) !== key) return [line];
    const next = line.qty + delta;
    if (next < 1) return [];
    return [{ ...line, qty: clampQty(next) }];
  });
}

export function removeItem(items: CartItem[], key: string): CartItem[] {
  return items.filter((line) => lineKey(line) !== key);
}

export function clearCart(): CartItem[] {
  return [];
}

/** Pieces, not lines — this is what the header badge shows. */
export function cartCount(items: CartItem[]): number {
  return items.reduce((total, line) => total + line.qty, 0);
}

export function cartSubtotal(items: CartItem[]): number {
  return money(items.reduce((total, line) => total + line.price * line.qty, 0));
}

function isCartItem(value: unknown): value is CartItem {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return (
    typeof line.productId === "string"
    && line.productId.length > 0
    && typeof line.name === "string"
    && typeof line.price === "number"
    && Number.isFinite(line.price)
    && typeof line.qty === "number"
    && Number.isFinite(line.qty)
    && line.qty >= 1
  );
}

/**
 * Rebuild a cart from whatever is in storage.
 *
 * Storage is user-writable and survives deploys, so it is treated as untrusted
 * input rather than as our own data: anything that is not a usable line is
 * dropped instead of being allowed to crash the drawer on the next render. A
 * customer returning to one salvageable line is a far better outcome than a
 * blank page, and the alternative — trusting it — means a single stale entry
 * from an older build can break the shop for that visitor permanently, with no
 * way for them to know that clearing site data would fix it.
 */
export function loadCart(raw: string | null): CartItem[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isCartItem).map((line) => ({
    productId: line.productId,
    name: line.name,
    price: line.price,
    ...(line.note ? { note: line.note } : {}),
    qty: clampQty(line.qty),
  }));
}
