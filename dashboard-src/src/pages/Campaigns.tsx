import { useEffect, useState } from "react";
import { Send, Users, RefreshCw, Loader2, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { mailApi, type CampaignCustomer } from "@/lib/api";

const input = "w-full border rounded-md px-3 py-2 text-sm";

function Campaigns() {
  const [customers, setCustomers] = useState<CampaignCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function load() {
    try {
      setLoading(true);
      setCustomers(await mailApi.customers());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load customers.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function send() {
    setMsg(null);
    if (!subject.trim() || !body.trim()) return setMsg({ text: "Subject and message are required.", ok: false });
    if (!customers.length) return setMsg({ text: "No customers with an email address yet.", ok: false });
    if (!confirm(`Send this email to ${customers.length} customer(s)?`)) return;
    setSending(true);
    try {
      const res = await mailApi.broadcast({ subject: subject.trim(), body: body.trim() });
      setMsg({ text: `✓ Sent to ${res.sent} customer(s)${res.failed ? `, ${res.failed} failed. Do not resend the whole campaign: successful recipients would receive it again.` : "."}`, ok: res.failed === 0 });
      if (res.failed === 0) { setSubject(""); setBody(""); }
    } catch (err) {
      setMsg({ text: err instanceof Error ? err.message : "Failed to send.", ok: false });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle><Send className="w-4 h-4" /> Compose campaign</CardTitle>
            <CardDescription>
              A one-off email to all {customers.length} customer(s) with an email on file. Each person gets their own
              email (they can't see each other). Sends through Brevo.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input className={input} aria-label="Subject" maxLength={200} placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <textarea className={`${input} min-h-[200px] resize-y`} aria-label="Message" maxLength={20000} placeholder="Write your message… (line breaks are preserved)"
              value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Info className="w-3.5 h-3.5" /> A greeting like “Hi {"{name}"}” is added automatically when we know the name.
            </div>
            <Button onClick={send} disabled={sending || loading || !!error || !customers.length} className="gap-1.5">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send to {customers.length} customer(s)
            </Button>
            {msg && <p className={`text-sm ${msg.ok ? "text-green-600" : "text-destructive"}`}>{msg.text}</p>}
          </CardContent>
        </Card>
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle><Users className="w-4 h-4" /> Customers</CardTitle>
            <CardDescription>Built from emails on past orders.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : error ? (
              <p className="text-destructive text-sm">{error}</p>
            ) : customers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No customer emails yet.</p>
            ) : (
              <ul className="space-y-2 max-h-[360px] overflow-auto">
                {customers.map((c) => (
                  <li key={c.email} className="text-sm border-b border-border/60 pb-1.5 last:border-0">
                    <p className="font-medium truncate">{c.name || "—"}</p>
                    <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function CampaignPage() {
  return <div><div className="flex items-center justify-between mb-6 gap-3"><div><h1 className="text-2xl font-bold">Campaigns</h1><p className="text-sm text-muted-foreground mt-1">One-off emails to Holland Cookies customers</p></div><Button variant="outline" size="sm" onClick={() => window.location.reload()}><RefreshCw className="w-4 h-4 mr-2" />Refresh</Button></div><Campaigns /></div>;
}
