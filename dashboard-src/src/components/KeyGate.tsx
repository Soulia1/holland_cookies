import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { forgetSaved, hasValidSession, prefetch, restoreSaved, setSessionLostHandler, signIn } from "@/lib/api";

export default function KeyGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // The session lives in an httpOnly cookie, so the only way to know whether
  // one exists is to ask the server. Hold the UI until that answer arrives.
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let active = true;
    // Three things at once, not one after another: the session check, putting
    // back what the last visit saved (so the page opens on it), and the fetch
    // for the page being opened. When the session is good — the usual case —
    // the page's data is already on its way by the time the gate opens.
    prefetch(window.location.pathname);
    Promise.all([hasValidSession(), restoreSaved().catch(() => {})])
      .then(([valid]) => {
        // No session: whatever this device saved from the last one goes.
        if (!valid) forgetSaved();
        if (active) setUnlocked(valid);
      })
      .catch(() => active && setUnlocked(false))
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, []);

  // Any 401 from a later request means the session expired or was revoked.
  useEffect(() => {
    setSessionLostHandler(() => setUnlocked(false));
    return () => setSessionLostHandler(null);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    setLoading(true);
    setError("");
    try {
      await signIn(key.trim());
      setKey(""); // never keep the master key around after the exchange
      setUnlocked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Admin access was denied.");
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-sidebar p-6">
        <p className="text-sm text-muted-foreground">Checking your session…</p>
      </div>
    );
  }

  if (unlocked) return <>{children}</>;

  return (
    <div className="flex min-h-screen items-center justify-center bg-sidebar p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>🍪 Holland Cookies Admin</CardTitle>
          <CardDescription>Enter the admin key to open the dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-3">
            <label htmlFor="admin-key" className="sr-only">Admin key</label>
            <input
              id="admin-key"
              name="password"
              type="password"
              className="adm-input"
              placeholder="Admin key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
              autoComplete="current-password"
              aria-describedby={error ? "admin-key-error" : undefined}
            />
            {error && <p id="admin-key-error" role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
