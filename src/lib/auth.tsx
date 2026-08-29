import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { api, type Customer } from "@/lib/api";

/**
 * Who is signed in.
 *
 * There are no passwords: a one-time code is emailed to an address, and
 * returning it proves the address. That proof is what lets the server attach
 * every past guest order placed with the same email — which is the whole point
 * of having accounts on a shop like this. Somebody who ordered three times as a
 * guest and then signs in should see those three orders, not an empty page.
 *
 * The session itself is an httpOnly cookie, so nothing here holds a credential
 * and there is no token to leak from JavaScript. This context holds only the
 * customer's own details, which the server hands back.
 */

interface AuthValue {
  customer: Customer | null;
  /** Null while the first `me` call is in flight — distinct from signed out. */
  ready: boolean;
  /** False when the server has no mail provider, so the sheet can say so. */
  mailConfigured: boolean;
  signIn: (customer: Customer) => void;
  signOut: () => Promise<void>;
  update: (customer: Customer) => void;
  /** Re-reads the session; used after a checkout that may have created one. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [ready, setReady] = useState(false);
  const [mailConfigured, setMailConfigured] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.me();
      setCustomer(result.customer);
      setMailConfigured(result.mailConfigured);
    } catch {
      // A network failure is not a signed-out state. Leaving the previous value
      // alone means a customer whose wifi blinked is not silently logged out of
      // a page they are part-way through using.
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signOut = useCallback(async () => {
    // Cleared locally first so the UI responds immediately; the request only
    // has to invalidate the cookie, and a slow network should not make Sign out
    // feel broken.
    setCustomer(null);
    try {
      await api.signOut();
    } catch {
      /* the cookie expires on its own regardless */
    }
  }, []);

  const value = useMemo<AuthValue>(() => ({
    customer,
    ready,
    mailConfigured,
    signIn: setCustomer,
    signOut,
    update: setCustomer,
    refresh,
  }), [customer, ready, mailConfigured, signOut, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside an AuthProvider");
  return context;
}
