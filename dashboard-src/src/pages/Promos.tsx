import { useEffect, useState, type FormEvent } from "react";
import { Ticket, Trash2, RefreshCw, Plus, Power } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { promosApi, type Promo } from "@/lib/api";
import { formatEGP } from "@/lib/format";

const input = "border rounded-md px-3 py-2 text-sm";
const emptyForm = { code: "", type: "percent" as "percent" | "fixed", value: "", minSubtotal: "", expiresAt: "", active: true, maxUses: "" };

export default function Promos() {
  const [promos, setPromos] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [formMsg, setFormMsg] = useState<{ text: string; ok: boolean } | null>(null);

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
    if (!form.code || !form.value) return setFormMsg({ text: "Code and value are required.", ok: false });
    try {
      await promosApi.create({
        code: form.code,
        type: form.type,
        value: Number(form.value),
        minSubtotal: form.minSubtotal ? Number(form.minSubtotal) : 0,
        expiresAt: form.expiresAt || "",
        active: form.active,
        maxUses: form.maxUses ? Number(form.maxUses) : 0,
      });
      setForm(emptyForm);
      setFormMsg({ text: "✓ Promo code created.", ok: true });
      load();
    } catch (err) {
      setFormMsg({ text: err instanceof Error ? err.message : "Failed to create code.", ok: false });
    }
  }

  async function toggle(p: Promo) {
    try {
      await promosApi.update(p.id, { active: !p.active });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update code.");
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this promo code?")) return;
    try {
      await promosApi.remove(id);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete code.");
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

      {error && <p className="text-destructive text-sm mb-4">{error}</p>}

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
                {p.expiresAt && <p className="text-xs text-muted-foreground">Expires {new Date(p.expiresAt).toLocaleDateString()}</p>}
                <div className="flex gap-2 mt-3">
                  <Button size="sm" variant="outline" className="flex-1 gap-1.5" onClick={() => toggle(p)}>
                    <Power className="w-3.5 h-3.5" /> {p.active ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="outline" className="flex-1 gap-1.5 text-destructive" onClick={() => remove(p.id)}>
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
              <label className="text-xs font-medium text-muted-foreground mb-1 block">Expiry (optional)</label>
              <input className={`${input} w-full`} type="date"
                value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm self-end pb-2">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active immediately
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" className="gap-1.5"><Plus className="w-4 h-4" /> Create code</Button>
              {formMsg && <p className={`text-sm mt-2 ${formMsg.ok ? "text-green-600" : "text-destructive"}`}>{formMsg.text}</p>}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
