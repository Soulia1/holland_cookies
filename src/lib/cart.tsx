import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CART_STORAGE_KEY,
  addItem as addToCart,
  cartCount,
  cartSubtotal,
  changeQty as changeCartQty,
  clearCart as emptyCart,
  loadCart,
  removeItem as removeFromCart,
  type CartItem,
} from "./cart-core";

/**
 * The cart, as React sees it.
 *
 * All of the arithmetic lives in `cart-core.ts` and none of it is repeated
 * here. What this file adds is the three things a pure module cannot have: a
 * place for the state to live, persistence, and the open/closed state of the
 * drawer. If you are looking for what happens when a quantity changes, it is
 * not in this file.
 */

interface CartContextValue {
  items: CartItem[];
  count: number;
  subtotal: number;
  open: boolean;
  /** The most recent add, for the confirmation feedback. Cleared on a timer. */
  lastAdded: string | null;
  add: (item: Omit<CartItem, "qty">, qty?: number) => void;
  setQty: (key: string, delta: number) => void;
  remove: (key: string) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

const CartContext = createContext<CartContextValue | null>(null);

/** How long the "added" confirmation stays up before it stops being news. */
const ADDED_FEEDBACK_MS = 1800;

export function CartProvider({ children }: { children: ReactNode }) {
  // Read once, lazily, in the initialiser rather than in an effect: reading it
  // in an effect renders an empty cart first, so a returning customer watches
  // their cart badge appear a frame after the header does.
  const [items, setItems] = useState<CartItem[]>(() => {
    if (typeof localStorage === "undefined") return [];
    try {
      return loadCart(localStorage.getItem(CART_STORAGE_KEY));
    } catch {
      return [];
    }
  });
  const [open, setOpen] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const addedTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Storage full, or private mode. The cart still works for this visit.
    }
  }, [items]);

  useEffect(() => () => window.clearTimeout(addedTimer.current), []);

  const add = useCallback((item: Omit<CartItem, "qty">, qty = 1) => {
    setItems((current) => addToCart(current, item, qty));
    setLastAdded(item.productId);
    window.clearTimeout(addedTimer.current);
    addedTimer.current = window.setTimeout(() => setLastAdded(null), ADDED_FEEDBACK_MS);
  }, []);

  const setQty = useCallback((key: string, delta: number) => {
    setItems((current) => changeCartQty(current, key, delta));
  }, []);

  const remove = useCallback((key: string) => {
    setItems((current) => removeFromCart(current, key));
  }, []);

  const clear = useCallback(() => setItems(emptyCart()), []);

  // Derived rather than stored. A stored count is a second source of truth that
  // can disagree with the lines it counts, and there is no version of that bug
  // that is cheap to find.
  const value = useMemo<CartContextValue>(
    () => ({
      items,
      count: cartCount(items),
      subtotal: cartSubtotal(items),
      open,
      lastAdded,
      add,
      setQty,
      remove,
      clear,
      setOpen,
    }),
    [items, open, lastAdded, add, setQty, remove, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error("useCart must be used inside a CartProvider");
  return context;
}
