import { useEffect, useState } from "react";
import { Banknote, Loader2, Mail, MapPin, ShieldCheck, Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { settingsApi, type ShopSettings } from "@/lib/api";

const input = "w-full border rounded-md px-3 py-2 text-sm";
const label = "text-xs font-medium text-muted-foreground mb-1 block";

/**
 * Settings.
 *
 * Only what the server stores and enforces is editable, and "saved" is shown
 * only after the values have been read back from the server. The page this
 * replaced offered a store name, contact email, pickup address, pickup hours and
 * two cutoff hours, and reported every one as saved while nothing stored them
 * and nothing read them. They are gone rather than faked.
 */

type Draft = { deliveryFee: string; freeDeliveryOver: string; acceptingOrders: boolean };

const draftOf = (settings: ShopSettings): Draft => ({
  deliveryFee: String(settings.deliveryFee ?? 0),
  freeDeliveryOver: String(settings.freeDeliveryOver ?? 0),
  acceptingOrders: settings.acceptingOrders !== false,
});

/** Why an amount field cannot be saved, or null. Checked so `NaN` never reaches the request. */
function amountProblem(value: string, name: string): string | null {
  if (!value.trim()) return `Enter the ${name}. Use 0 for none.`;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return `The ${name} must be a number, zero or more.`;
  if (amount > 1_000_000) return `The ${name} is too large.`;
  return null;
}

export default function Settings() {
  const [saved, setSaved] = useState<ShopSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    setLoadError("");
    try {
      const settings = await settingsApi.get();
      setSaved(settings);
      setDraft(draftOf(settings));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load settings.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function save() {
    if (!draft || saving) return;
    const problem = amountProblem(draft.deliveryFee, "delivery fee")
      ?? amountProblem(draft.freeDeliveryOver, "free-delivery threshold");
    if (problem) {
      setMsg({ text: problem, ok: false });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const next = await settingsApi.update({
        deliveryFee: Number(draft.deliveryFee),
        freeDeliveryOver: Number(draft.freeDeliveryOver),
        acceptingOrders: draft.acceptingOrders,
      });
      setSaved(next);
      setDraft(draftOf(next));
      setMsg({ text: "✓ Saved. Checkout uses these values from now on.", ok: true });
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Could not save settings.", ok: false });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p role="alert" className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    );
  }
  if (!saved || !draft) {
    return <p className="text-sm text-muted-foreground py-10 text-center">Loading settings…</p>;
  }

  const edit = (patch: Partial<Draft>) => {
    setMsg(null);
    setDraft({ ...draft, ...patch });
  };
  const dirty = draft.deliveryFee !== String(saved.deliveryFee)
    || draft.freeDeliveryOver !== String(saved.freeDeliveryOver)
    || draft.acceptingOrders !== saved.acceptingOrders;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle><Truck className="w-4 h-4" /> Ordering and delivery</CardTitle>
          <CardDescription>
            Stored on the server and applied to every order. The server charges these
            figures itself — checkout only displays them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-start gap-3 text-sm">
            <input
              id="accepting-orders"
              type="checkbox"
              className="mt-0.5 size-4 accent-primary"
              checked={draft.acceptingOrders}
              onChange={(e) => edit({ acceptingOrders: e.target.checked })}
            />
            <span>
              <span className="font-medium">Accepting orders</span>
              <span className="block text-xs text-muted-foreground">
                When off, checkout tells customers ordering is paused and the server refuses
                every new order.
              </span>
            </span>
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="delivery-fee">Delivery fee (EGP)</label>
              <input id="delivery-fee" className={input} type="number" min="0" step="0.01" inputMode="decimal"
                value={draft.deliveryFee} onChange={(e) => edit({ deliveryFee: e.target.value })} />
            </div>
            <div>
              <label className={label} htmlFor="free-delivery-over">Free delivery over (EGP)</label>
              <input id="free-delivery-over" className={input} type="number" min="0" step="0.01" inputMode="decimal"
                value={draft.freeDeliveryOver} onChange={(e) => edit({ freeDeliveryOver: e.target.value })} />
              <p className="text-xs text-muted-foreground mt-1">0 means delivery is never free.</p>
            </div>
          </div>

          <div>
            <Button onClick={() => void save()} disabled={saving || !dirty}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />} Save settings
            </Button>
            {msg && (
              <p role={msg.ok ? "status" : "alert"}
                className={`text-sm mt-2 ${msg.ok ? "text-green-600" : "text-destructive"}`}>
                {msg.text}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><MapPin className="w-4 h-4" /> Delivery areas</CardTitle>
          <CardDescription>
            Checkout offers exactly these areas and the server refuses any other. They are
            stored with the shop settings and are not editable from the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {saved.areas.length ? (
            <ul className="flex flex-wrap gap-2 text-sm" aria-label="Delivery areas">
              {saved.areas.map((area) => (
                <li key={area.id} className="rounded-md border border-border px-2.5 py-1">
                  {area.name}
                  {area.nameAr && <span className="text-muted-foreground" dir="rtl"> · {area.nameAr}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No areas are configured, so any area is accepted.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><Banknote className="w-4 h-4" /> Payment</CardTitle>
          <CardDescription>Cash only.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Customers pay cash on delivery or at the counter on pickup. No online payment
            is connected.
          </p>
          <p className="text-muted-foreground">
            Once an order is completed, mark its cash as collected from the Orders page. That
            is an internal record for the shop, not a payment.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><Mail className="w-4 h-4" /> Email</CardTitle>
          <CardDescription>
            {saved.emailEnabled ? "Email provider switched on" : "Email provider not configured"}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {saved.emailEnabled ? (
            <p>An email provider is switched on in the server environment.</p>
          ) : (
            <p>
              No order confirmations or sign-in codes are emailed, and customer accounts are
              hidden on the shop. Orders and tracking are not affected.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle><ShieldCheck className="w-4 h-4" /> Admin access</CardTitle>
          <CardDescription>How this dashboard is protected.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Sign-in exchanges the <code className="rounded bg-muted px-1 py-0.5 text-xs">ADMIN_KEY</code>{" "}
            set in the server environment for a session cookie that lasts 12 hours. There is no
            separate dashboard password.
          </p>
          <p className="text-muted-foreground">
            Rotating <code className="rounded bg-muted px-1 py-0.5 text-xs">ADMIN_KEY</code> stops new
            sign-ins with the old key; rotating{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">JWT_SECRET</code> also ends every
            existing session.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
