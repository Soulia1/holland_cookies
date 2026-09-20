import { useEffect, useState } from "react";
import { Banknote, Loader2, Mail, MapPin, Plus, ShieldCheck, Trash2, Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { settingsApi, type DeliveryArea, type ShopSettings } from "@/lib/api";
import { DEFAULT_AREAS } from "@shared/deliveryAreas.mjs";

const input = "w-full border rounded-md px-3 py-2 text-sm";
// Same field, fixed width. Not `${input} w-28`: both are width utilities and
// which one wins is decided by their order in the stylesheet, not by the order
// they are written in here — `w-full` won, and the governorate box filled the
// row on a phone.
const narrowInput = "w-28 shrink-0 border rounded-md px-3 py-2 text-sm";
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

type Draft = {
  deliveryFee: string;
  freeDeliveryOver: string;
  acceptingOrders: boolean;
  areas: DeliveryArea[];
};

const draftOf = (settings: ShopSettings): Draft => ({
  deliveryFee: String(settings.deliveryFee ?? 0),
  freeDeliveryOver: String(settings.freeDeliveryOver ?? 0),
  acceptingOrders: settings.acceptingOrders !== false,
  areas: (settings.areas ?? []).map((area) => ({ ...area })),
});

/**
 * An id for an area typed here.
 *
 * Made from the name, like the Menu page makes a product id from its name, and
 * for the same reason: a hand-typed id with a capital or a space in it is
 * refused by the server with "Check the fields." and the admin has no way to
 * see why. It is assigned once, when the new row is saved, and never re-derived
 * afterwards — orders store this id, and a rename that changed it would leave
 * every order already placed to the area with no name at all.
 */
function areaId(name: string, taken: readonly string[]): string {
  const base = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "area";
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 60);
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`.slice(0, 60);
}

/** Why the area list cannot be saved, or null. */
function areasProblem(areas: readonly DeliveryArea[]): string | null {
  for (const area of areas) {
    if (!area.name.trim()) return "Every delivery area needs a name.";
  }
  const ids = areas.map((area) => area.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) return "Two areas have the same id.";
  if (areas.length > 80) return "A shop can offer at most 80 delivery areas.";
  return null;
}

/** The list with an id filled in for every row that was just added. */
function withIds(areas: readonly DeliveryArea[]): DeliveryArea[] {
  const taken = areas.map((area) => area.id).filter(Boolean);
  return areas.map((area) => {
    if (area.id) return area;
    const id = areaId(area.name, taken);
    taken.push(id);
    return { ...area, id };
  });
}

/** The same two lists in the same order, ids included. */
function sameAreas(a: readonly DeliveryArea[], b: readonly DeliveryArea[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((area, index) => {
    const other = b[index];
    return area.id === other.id
      && area.name === other.name
      && (area.nameAr ?? "") === (other.nameAr ?? "")
      && (area.city ?? "") === (other.city ?? "")
      && (area.cityAr ?? "") === (other.cityAr ?? "");
  });
}

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
      ?? amountProblem(draft.freeDeliveryOver, "free-delivery threshold")
      ?? areasProblem(draft.areas);
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
        // Sent whole: the areas the shop offers are exactly this list, and a
        // patch of "the ones that changed" has no way to say one was removed.
        areas: withIds(draft.areas).map((area) => ({
          id: area.id,
          name: area.name.trim(),
          nameAr: (area.nameAr ?? "").trim(),
          city: (area.city ?? "").trim(),
          cityAr: (area.cityAr ?? "").trim(),
        })),
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
    || draft.acceptingOrders !== saved.acceptingOrders
    || !sameAreas(draft.areas, saved.areas ?? []);

  const editArea = (index: number, patch: Partial<DeliveryArea>) =>
    edit({ areas: draft.areas.map((area, at) => (at === index ? { ...area, ...patch } : area)) });

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
            Checkout offers exactly these areas and the server refuses any other. The
            governorate is what checkout groups the list under, so a customer can tell which
            side of the river an unfamiliar name is on. Save with the button above.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.areas.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No areas are configured, so checkout accepts any area.
            </p>
          )}

          <ul className="space-y-3" aria-label="Delivery areas">
            {draft.areas.map((area, index) => (
              // Keyed by position: a row added here has no id until it is
              // saved, so there is nothing else stable to key on, and the
              // values all come from state rather than from the DOM.
              <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <input
                  className={`${input} min-w-36 flex-1`}
                  aria-label={`Area ${index + 1} name`}
                  placeholder="Nasr City"
                  maxLength={120}
                  value={area.name}
                  onChange={(e) => editArea(index, { name: e.target.value })}
                />
                <input
                  className={`${input} min-w-32 flex-1`}
                  aria-label={`Area ${index + 1} Arabic name`}
                  placeholder="Arabic (optional)"
                  dir="rtl"
                  maxLength={120}
                  value={area.nameAr ?? ""}
                  onChange={(e) => editArea(index, { nameAr: e.target.value })}
                />
                <input
                  className={narrowInput}
                  aria-label={`Area ${index + 1} governorate`}
                  placeholder="Cairo"
                  maxLength={60}
                  value={area.city ?? ""}
                  onChange={(e) => editArea(index, { city: e.target.value })}
                />
                <input
                  className={narrowInput}
                  aria-label={`Area ${index + 1} governorate in Arabic`}
                  placeholder="القاهرة"
                  dir="rtl"
                  maxLength={60}
                  value={area.cityAr ?? ""}
                  onChange={(e) => editArea(index, { cityAr: e.target.value })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove area ${index + 1}`}
                  onClick={() => edit({ areas: draft.areas.filter((_, at) => at !== index) })}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => edit({
                areas: [
                  ...draft.areas,
                  { id: "", name: "", nameAr: "", city: "", cityAr: "" },
                ],
              })}
            >
              <Plus className="w-4 h-4" /> Add area
            </Button>
            {/* The list a Cairo shop would otherwise type forty times. Areas
                already in the list keep their own row — an id is what orders
                store, so adding the preset must never replace one. */}
            <Button
              variant="outline"
              onClick={() => {
                const have = new Set(draft.areas.map((area) => area.id));
                const missing = DEFAULT_AREAS.filter((area) => !have.has(area.id));
                if (!missing.length) {
                  setMsg({ text: "Every Cairo and Giza area is already in the list.", ok: true });
                  return;
                }
                edit({ areas: [...draft.areas, ...missing.map((area) => ({ ...area }))] });
              }}
            >
              <Plus className="w-4 h-4" /> Add all Cairo &amp; Giza areas
            </Button>
          </div>

          <p className="text-xs text-muted-foreground">
            Renaming an area is safe — orders store its id, not its name. Removing one stops
            checkout offering it; orders already placed to it keep their address.
          </p>
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
