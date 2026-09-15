import { useEffect, useState, type FormEvent } from "react";
import { Ticket, Trash2, RefreshCw, Plus, Power } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { promosApi, type Promo } from "@/lib/api";
import { formatEGP } from "@/lib/format";
import { endOfShopDay, shopDateOf } from "@shared/cairoTime.mjs";

const input = "border rounded-md px-3 py-2 text-sm";
const emptyForm = { code: "", type: "percent" as "percent" | "fixed", value: "", minSubtotal: "", expiresAt: "", active: true, maxUses: "" };

/**
 * The date picker's `YYYY-MM-DD` as the instant the code stops working, as the
 * ISO timestamp the server expects. No date means no expiry — `null`, never an
 * empty string.
 *
 * The shop's clock decides, not the operator's: a code set to 30 September
 * works until 23:59:59.999 on 30 September in Cairo, whatever time zone the
 * laptop it was typed on is set to. See shared/cairoTime.mjs.
 */
export function expiryFromDate(date: string): string | null {
  return endOfShopDay(date);
}

/** Why the form cannot be sent, in words, or null. Numbers are checked before NaN can reach the request. */
function formProblem(form: typeof emptyForm): string | null {
  const code = form.code.trim();
  if (!code) return "Enter a code.";
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(code)) return "A code is 2–40 letters, numbers, hyphens or underscores.";
  const value = Number(form.value);
  if (!form.value.trim() || !Number.isFinite(value) || value <= 0) return "Enter a discount greater than zero.";
  if (form.type === "percent" && value >= 100) return "A percentage discount must be below 100.";
  if (form.minSubtotal.trim() && (!Number.isFinite(Number(form.minSubtotal)) || Number(form.minSubtotal) < 0)) {
    return "The minimum order must be zero or more.";
  }
  if (form.maxUses.trim() && (!Number.isInteger(Number(form.maxUses)) || Number(form.maxUses) < 0)) {
    return "Max uses must be a whole number.";
  }
  if (form.expiresAt && !expiryFromDate(form.expiresAt)) return "Choose a valid expiry date.";
  const expiry = expiryFromDate(form.expiresAt);
  if (expiry && new Date(expiry).getTime() <= Date.now()) return "That expiry date has already passed.";
  return null;
}

export default function Promos() {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [formMsg, setFormMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyCode, setBusyCode] = useState("");

  async function load() {
    try {
      setLoading(true);
      setPromos(await promosApi.list());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load promo codes.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setFormMsg(null);
    if (creating) return;
    const problem = formProblem(form);
    if (problem) return setFormMsg({ text: problem, ok: false });
    setCreating(true);
    try {
      await promosApi.create({
        code: form.code.trim(),
        type: form.type,
        value: Number(form.value),
        minSubtotal: form.minSubtotal.trim() ? Number(form.minSubtotal) : 0,
        expiresAt: expiryFromDate(form.expiresAt),
        active: form.active,
        maxUses: form.maxUses.trim() ? Number(form.maxUses) : 0,
      } as Partial<Promo> & { code: string; expiresAt: string | null });
      setForm(emptyForm);
      setFormMsg({ text: "✓ Promo code created.", ok: true });
      await load();
    } catch (err) {
      setFormMsg({ text: err instanceof Error ? err.message : "Failed to create code.", ok: false });
    } finally {
      setCreating(false);
    }
  }

  async function toggle(p: Promo) {
    setBusyCode(p.id);
    try {
      await promosApi.update(p.id, { active: !p.active });
      setError("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update code.");
    } finally {
      setBusyCode("");
    }
  }

  async function remove(id: string) {
    if (!confirm(`Delete the promo code ${id}? Customers will no longer be able to use it.`)) return;
    setBusyCode(id);
    try {
      await promosApi.remove(id);
      setError("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete code.");
    } finally {
      setBusyCode("");
    }
  }

  function describe(p: Promo) {
    return p.type === "percent" ? `${p.value}% off` : `${formatEGP(p.value)} off`;
  }
  function isExpired(p: Promo) {
    return p.expiresAt && new Date(p.expiresAt).getTime() < Date.now();
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Promo Codes</h1>
          <p className="text-sm text-muted-foreground mt-1">{promos.length} codes</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-2">
          <RefreshCw className="w-4 h-4" /> Refresh
        </Button>
      </div>

      {error && <p role="alert" className="text-destructive text-sm mb-4">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted-foreground py-10 text-center">Loading codes…</p>
      ) : promos.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6">No promo codes yet. Create one below.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {promos.map((p) => (
            <Card key={p.id}>
              <CardContent className="pt-0">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono font-bold tracking-wider">{p.code}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                    isExpired(p) ? "bg-muted text-muted-foreground"
                    : p.active ? "bg-green-100 text-green-700" : "bg-muted text-muted-foreground"
                  }`}>
                    {isExpired(p) ? "Expired" : p.active ? "Active" : "Inactive"}
                  </span>
                </div>
                <p className="text-sm font-semibold">{describe(p)}</p>
                {!!p.minSubtotal && <p className="text-xs text-muted-foreground">Min order {formatEGP(p.minSubtotal)}</p>}
                {!!p.maxUses && (
                  <p className="text-xs text-muted-foreground">Used {p.usedCount || 0} / {p.maxUses}</p>
                )}
                {p.expiresAt && <p className="text-xs text-muted-foreground">Expires after {shopDateOf(p.expiresAt)} (Cairo time)</p>}
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="outline" className="flex-1 gap-1.5" disabled={busyCode === p.id} onClick={() => toggle(p)}>
                    <Power className="w-3.5 h-3.5" /> {p.active ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1 gap-1.5 text-destructive" disabled={busyCode === p.id} onClick={() => remove(p.id)}>
                    <Trash2 className="w-3.5 h-3.5" /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle><Ticket className="w-4 h-4" /> Create Promo Code</CardTitle>
          <CardDescription>Percentage or fixed-amount discount, applied at checkout.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input className={`${input} font-mono uppercase`} placeholder="CODE (e.g. WELCOME10)"
              value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
            <select className={input} value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as "percent" | "fixed" })}>
              <option value="percent">Percentage (%)</option>
              <option value="fixed">Fixed amount (EGP)</option>
            </select>
            <input className={input} type="number" placeholder={form.type === "percent" ? "Discount % (e.g. 10)" : "Amount off in EGP"}
              value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            <input className={input} type="number" placeholder="Min order EGP (optional)"
              value={form.minSubtotal} onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })} />
            <input className={input} type="number" placeholder="Max uses (optional, e.g. 50)"
              value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1 block" htmlFor="promo-expiry">Last day (optional)</label>
              <input id="promo-expiry" className={`${input} w-full`} type="date"
                value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
              <p className="text-xs text-muted-foreground mt-1">The code stops working at the end of that day, Cairo time.</p>
            </div>
            <label className="flex items-center gap-2 text-sm self-end pb-2">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active immediately
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" className="gap-1.5" disabled={creating}>
                <Plus className="w-4 h-4" /> {creating ? "Creating…" : "Create code"}
              </Button>
              {formMsg && <p role={formMsg.ok ? "status" : "alert"} className={`text-sm mt-2 ${formMsg.ok ? "text-green-600" : "text-destructive"}`}>{formMsg.text}</p>}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
