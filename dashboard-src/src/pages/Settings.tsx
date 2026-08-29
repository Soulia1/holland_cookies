import { useEffect, useState } from "react";
import { Mail, Store, ShieldCheck, CheckCircle2, Loader2, Truck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { settingsApi, mailApi, type Settings as SettingsType } from "@/lib/api";
import { deliveryAreasSummary, clockToHour24, hour24ToClock } from "@/lib/fulfillment";

const input = "w-full border rounded-md px-3 py-2 text-sm";
const label = "text-xs font-medium text-muted-foreground mb-1 block";

/** A 0–23 Cairo hour, edited as a familiar 12-hour + AM/PM pair. */
function HourPicker({ value, onChange }: { value: number; onChange: (hour24: number) => void }) {
  const { hour12, period } = hour24ToClock(value);
  return (
    <div className="flex gap-2">
      <select
        className="min-w-0 flex-1 border rounded-md px-3 py-2 text-sm"
        value={hour12}
        onChange={(e) => onChange(clockToHour24(Number(e.target.value), period))}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>{h}:00</option>
        ))}
      </select>
      <select
        className="shrink-0 w-[80px] border rounded-md px-3 py-2 text-sm"
        value={period}
        onChange={(e) => onChange(clockToHour24(hour12, e.target.value as "AM" | "PM"))}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
    </div>
  );
}

function Msg({ msg }: { msg: { text: string; ok: boolean } | null }) {
  if (!msg) return null;
  return <p className={`text-sm mt-2 ${msg.ok ? "text-green-600" : "text-destructive"}`}>{msg.text}</p>;
}

export default function Settings() {
  const [loading, setLoading] = useState(true);
  const [mail, setMail] = useState({
    configured: false,
    provider: "brevo" as const,
    source: "environment" as const,
    fromName: "",
    fromEmail: "",
    replyTo: "",
  });
  const [store, setStore] = useState({ name: "", email: "" });
  const [storeMsg, setStoreMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [savingStore, setSavingStore] = useState(false);

  const [mailMsg, setMailMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [testTo, setTestTo] = useState("");

  // deliveryAreas is read-only and comes from the server on every load. The
  // page must never name an area itself — that is what made it claim Sheikh
  // Zayed only while the backend was accepting 6th of October too.
  const [fulfillment, setFulfillment] = useState({
    pickupAddress: "", pickupHours: "", deliveryAreas: [] as string[], deliveryFee: 0, cutoffHour: 12,
    pickupCutoffHour: 20,
  });
  const [fMsg, setFMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [savingF, setSavingF] = useState(false);

  function apply(s: SettingsType) {
    setMail(s.mail);
    setStore(s.store);
    if (s.fulfillment) {
      setFulfillment({
        pickupAddress: s.fulfillment.pickupAddress,
        pickupHours: s.fulfillment.pickupHours,
        deliveryAreas: s.fulfillment.deliveryAreas ?? [],
        deliveryFee: s.fulfillment.deliveryFee,
        cutoffHour: s.fulfillment.cutoffHour,
        pickupCutoffHour: s.fulfillment.pickupCutoffHour,
      });
    }
  }

  async function saveFulfillment() {
    setFMsg(null);
    setSavingF(true);
    try {
      // deliveryAreas is deliberately not sent: the server owns that list and
      // ignores any client attempt to set it.
      const next = await settingsApi.update({
        fulfillment: {
          pickupAddress: fulfillment.pickupAddress,
          pickupHours: fulfillment.pickupHours,
          deliveryFee: Number(fulfillment.deliveryFee) || 0,
          cutoffHour: Number(fulfillment.cutoffHour),
          pickupCutoffHour: Number(fulfillment.pickupCutoffHour),
        },
      });
      apply(next);
      setFMsg({ text: "✓ Fulfillment settings saved.", ok: true });
    } catch (err) {
      setFMsg({ text: err instanceof Error ? err.message : "Failed to save.", ok: false });
    } finally {
      setSavingF(false);
    }
  }

  useEffect(() => {
    settingsApi.get().then(apply).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function saveStore() {
    setStoreMsg(null);
    setSavingStore(true);
    try {
      const next = await settingsApi.update({ store });
      apply(next);
      setStoreMsg({ text: "Store settings saved.", ok: true });
    } catch (err) {
      setStoreMsg({ text: err instanceof Error ? err.message : "Failed to save.", ok: false });
    } finally {
      setSavingStore(false);
    }
  }

  async function verify() {
    setMailMsg(null);
    setVerifying(true);
    try {
      if (testTo.trim()) {
        await mailApi.test(testTo.trim());
        setMailMsg({ text: `Test email sent to ${testTo.trim()}.`, ok: true });
      } else {
        await mailApi.verify();
        setMailMsg({ text: "Brevo server configuration is present.", ok: true });
      }
    } catch (err) {
      setMailMsg({ text: err instanceof Error ? err.message : "Verification failed.", ok: false });
    } finally {
      setVerifying(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground py-10 text-center">Loading settings…</p>;

  const deliveryAreas = deliveryAreasSummary(fulfillment.deliveryAreas);

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {/* Store info */}
      <Card>
        <CardHeader>
          <CardTitle><Store className="w-4 h-4" /> Store</CardTitle>
          <CardDescription>Store details used by the dashboard.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>Store name</label>
            <input className={input} value={store.name} placeholder="Holland Cookies"
              onChange={(e) => setStore({ ...store, name: e.target.value })} />
          </div>
          <div>
            <label className={label}>Store contact email</label>
            <input className={input} value={store.email} placeholder="hello@hollandcookies.example"
              onChange={(e) => setStore({ ...store, email: e.target.value })} />
          </div>
          <div className="sm:col-span-2">
            <Button onClick={saveStore} disabled={savingStore}>
              {savingStore && <Loader2 className="w-4 h-4 animate-spin" />} Save store details
            </Button>
            <Msg msg={storeMsg} />
          </div>
        </CardContent>
      </Card>

      {/* Mail delivery */}
      <Card>
        <CardHeader>
          <CardTitle><Mail className="w-4 h-4" /> Mail delivery</CardTitle>
          <CardDescription>
            Order confirmations are sent through Brevo using server-only environment variables.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className={label}>Provider</label>
              <input className={input} value="Brevo" disabled />
            </div>
            <div>
              <label className={label}>Configuration</label>
              <input className={input} value={mail.configured ? "Configured" : "Missing server variables"} disabled />
            </div>
          </div>
          <div>
            <label className={label}>Reply-To</label>
            <input className={input} value={mail.replyTo || "Not configured"} disabled />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>From name</label>
              <input className={input} value={mail.fromName} disabled />
            </div>
            <div>
              <label className={label}>From email</label>
              <input className={input} value={mail.fromEmail} disabled />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mail.configured} disabled />
            Brevo configuration is managed in the server environment.
          </label>
          <p className="text-sm text-green-700">Order-confirmation email is always on and cannot be disabled.</p>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <input className={`${input} max-w-[220px]`} placeholder="test@email.com (optional)" value={testTo}
              onChange={(e) => setTestTo(e.target.value)} />
            <Button variant="outline" onClick={verify} disabled={verifying}>
              {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {testTo.trim() ? "Send test" : "Verify connection"}
            </Button>
          </div>
          <Msg msg={mailMsg} />
        </CardContent>
      </Card>

      {/* Fulfillment: pickup + delivery */}
      <Card>
        <CardHeader>
          <CardTitle><Truck className="w-4 h-4" /> Fulfillment</CardTitle>
          <CardDescription>
            Pickup details, delivery to {deliveryAreas}, and the Cairo same-day cutoff used at checkout.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Pickup address</label>
              <input className={input} value={fulfillment.pickupAddress} placeholder="Holland Cookies — …, Sheikh Zayed"
                onChange={(e) => setFulfillment({ ...fulfillment, pickupAddress: e.target.value })} />
            </div>
            <div>
              <label className={label}>Pickup hours</label>
              <input className={input} value={fulfillment.pickupHours} placeholder="Daily 8:00 PM – 2:00 AM"
                onChange={(e) => setFulfillment({ ...fulfillment, pickupHours: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={label}>
              Delivery {fulfillment.deliveryAreas.length === 1 ? "area" : "areas"}
            </label>
            <input className={input} value={deliveryAreas} disabled aria-describedby="delivery-area-policy" />
            <p id="delivery-area-policy" className="text-xs text-muted-foreground mt-1">
              Read from the server, which rejects orders to anywhere else. Changing the
              served areas is a code change to the backend&rsquo;s delivery list, not a
              setting — so this field and checkout can never disagree.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>Delivery fee (EGP)</label>
              <input className={input} type="number" value={fulfillment.deliveryFee}
                onChange={(e) => setFulfillment({ ...fulfillment, deliveryFee: Number(e.target.value) })} />
            </div>
            <div>
              <label className={label}>Delivery cutoff time (Cairo)</label>
              <HourPicker value={fulfillment.cutoffHour}
                onChange={(h) => setFulfillment({ ...fulfillment, cutoffHour: h })} />
              <p className="text-xs text-muted-foreground mt-1">Orders before this time deliver same-day; at/after, next day.</p>
            </div>
          </div>
          <div>
            {/* Separate from the delivery cutoff on purpose: the counter opens
                in the evening, so a lunchtime pickup order is still collectable
                that same night. Sharing one hour dated those to tomorrow. */}
            <label className={label}>Pickup cutoff time (Cairo)</label>
            <HourPicker value={fulfillment.pickupCutoffHour}
              onChange={(h) => setFulfillment({ ...fulfillment, pickupCutoffHour: h })} />
            <p className="text-xs text-muted-foreground mt-1">
              Usually the time the counter opens. Orders before it are ready to collect the
              same night; at/after, the next night. Independent of the delivery cutoff.
            </p>
          </div>
          <div>
            <Button onClick={saveFulfillment} disabled={savingF}>
              {savingF && <Loader2 className="w-4 h-4 animate-spin" />} Save fulfillment settings
            </Button>
            <Msg msg={fMsg} />
          </div>
        </CardContent>
      </Card>

      {/* Admin access.
          This card used to offer an "Admin password" field that confirmed
          "✓ Admin password updated." while changing nothing: the hash it saved
          was never read by the login route, which compares against ADMIN_KEY.
          A control that reports success without doing anything is worse than no
          control, so it is gone — replaced by a statement of what actually
          governs access. */}
      <Card>
        <CardHeader>
          <CardTitle><ShieldCheck className="w-4 h-4" /> Admin access</CardTitle>
          <CardDescription>How this dashboard is protected.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            Sign-in takes the <code className="rounded bg-muted px-1 py-0.5 text-xs">ADMIN_KEY</code>{" "}
            set in the server environment and exchanges it for a session. It stays valid as
            long as the dashboard is used at least once every 3 days, and asks for the key
            again a month after signing in. There is no separate dashboard password.
          </p>
          <p className="text-muted-foreground">
            To change who can get in, rotate <code className="rounded bg-muted px-1 py-0.5 text-xs">ADMIN_KEY</code>{" "}
            on the server. That takes effect immediately and signs out every existing session.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
