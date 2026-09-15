import { useEffect, useState } from "react";
import { ApiError, api, type Order, type Settings, type StatusEvent } from "@/lib/api";
import { localized, useLang, type Translations } from "@/lib/i18n";
import { Link } from "@/lib/router";
import { parseStamp } from "@/lib/dates";

/**
 * Order tracking.
 *
 * Ported from Scooby's track page: a white summary card carrying the reference,
 * a fulfilment badge, where it is going and what it cost — then a vertical
 * timeline of the steps with the time each one actually happened, then the
 * lines, then a way back to the form.
 *
 * The timestamps are the part that makes this worth having. A list of step
 * names tells a customer nothing they could not guess; "Baking · 18 Aug, 3:08 pm"
 * tells them the shop is really working on it. They come from the order's own
 * status history, which the dashboard writes on every change.
 *
 * Two fields on the form, because one is not enough. References are sequential
 * and readable by design — they have to be, so somebody can say "H C one
 * thousand and one" down a phone — which means they are also trivially
 * enumerable. Tracking on the reference alone would hand anyone who counts
 * upwards the name, address and phone number of every customer the shop has.
 */

/** The steps an order moves through, in order. Cancelled sits outside them. */
const STEPS = ["ordered", "confirmed", "baking", "in_transit", "completed"] as const;

const STATUS_KEY: Record<string, keyof Translations> = {
  ordered: "stPending",
  confirmed: "stConfirmed",
  baking: "stBaking",
  in_transit: "stOutForDelivery",
  completed: "stCompleted",
  cancelled: "stCancelled",
};

/** `YYYY-MM-DD HH:MM:SS` in UTC with no marker — the T and Z make it explicit. */
function when(stamp: string, lang: "en" | "ar"): string {
  return parseStamp(stamp).toLocaleString(
    lang === "ar" ? "ar-EG" : "en-GB",
    { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" },
  );
}

export default function TrackPage() {
  const { t, lang } = useLang();
  const [reference, setReference] = useState("");
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<{ order: Order; history: StatusEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  // The delivery areas, only so the summary can name one. Orders store the area
  // *id*, so without this the address line ended in `nasr-city` — the id the
  // select submitted rather than the name the customer chose.
  useEffect(() => {
    let active = true;
    api.settings()
      .then((result) => { if (active) setSettings(result.settings); })
      .catch(() => { /* the id is shown as-is, which is still true */ });
    return () => { active = false; };
  }, []);

  // The confirmation page links here with the reference already in the URL, so
  // the customer only has to supply the half they know by heart.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("ref");
    if (fromUrl) setReference(fromUrl);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.trackOrder(reference.trim(), phone.trim()));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof ApiError ? caught.message : t.trNotFound);
    } finally {
      setBusy(false);
    }
  }

  const order = result?.order;
  const cancelled = order?.status === "cancelled";
  const reached = order ? STEPS.indexOf(order.status as (typeof STEPS)[number]) : -1;

  // Each step, with the moment it happened. The history is a flat list of
  // states, so the first entry carrying a step's name is when it was reached —
  // a step the order has not got to yet simply has none, and renders without a
  // time rather than with an empty line where one should be.
  const steps = STEPS.map((step, index) => ({
    key: step,
    name: t[STATUS_KEY[step]] as string,
    at: result?.history.find((entry) => entry.status === step)?.created_at,
    done: index <= reached,
  }));

  const delivering = order?.fulfilment === "delivery";
  const areaName = order?.delivery.area
    ? (() => {
      const area = settings?.areas.find((candidate) => candidate.id === order.delivery.area);
      return area ? localized(lang, area.name, area.nameAr) : order.delivery.area;
    })()
    : "";
  const address = order
    ? [order.delivery.address, order.delivery.building && `#${order.delivery.building}`, areaName]
      .filter(Boolean).join(", ")
    : "";

  return (
    <main className="ed-page">
      <div className="ed-shell ed-placed">
        <span className="ed-tag">{t.okTrack}</span>
        <h1 className="ed-title" style={{ marginBlockEnd: order ? 28 : 14 }}>{t.trTitle}</h1>

        {!order && (
          <>
            <p className="ed-note" style={{ marginBlockEnd: 32 }}>{t.trIntro}</p>
            <form onSubmit={submit} noValidate>
              <div className="ed-field">
                <label className="ed-label" htmlFor="track-ref">{t.trReference}</label>
                <input id="track-ref" className="ed-input" dir="ltr"
                  placeholder={t.trReferencePlaceholder}
                  value={reference} onChange={(event) => setReference(event.target.value)} />
              </div>
              <div className="ed-field">
                <label className="ed-label" htmlFor="track-phone">{t.trPhone}</label>
                <input id="track-phone" className="ed-input" type="tel" inputMode="tel" dir="ltr"
                  autoComplete="tel" placeholder="010 1234 5678"
                  value={phone} onChange={(event) => setPhone(event.target.value)} />
              </div>
              {error && <p className="ed-alert" role="alert">{error}</p>}
              <button type="submit" className="ed-btn"
                disabled={busy || !reference.trim() || !phone.trim()}>
                {busy ? t.trSearching : t.trSubmit}
              </button>
            </form>
          </>
        )}

        {order && (
          <div aria-live="polite">
            {/* — Summary card ————————————————————————————— */}
            <div className="trk-card">
              <div className="trk-card-head">
                <span className="trk-ref" dir="ltr">{order.reference}</span>
                <span className={`trk-badge is-${cancelled ? "cancelled" : order.fulfilment}`}>
                  {cancelled
                    ? t.stCancelled
                    : delivering ? t.trBadgeDelivery : t.trBadgePickup}
                </span>
              </div>
              {delivering && address && (
                <p className="trk-line">{t.trDeliveringTo} {address}</p>
              )}
              {!delivering && <p className="trk-line">{t.trPickupFrom}</p>}
              <p className="trk-line">{t.trPlacedOn} {when(order.createdAt, lang)}</p>
              <p className="trk-total">
                {t.trTotal} <strong>{t.price(order.totals.total)}</strong>
              </p>
            </div>

            {/* — Timeline ————————————————————————————————— */}
            {cancelled ? (
              <div className="trk-cancelled">
                <p className="trk-cancelled-title">{t.stCancelled}</p>
                <p className="trk-line">{t.trCancelledHelp}</p>
              </div>
            ) : (
              // An ordered list, because the steps genuinely are one. The
              // connector is its own element rather than a border on the mark,
              // so it stops cleanly at the last step instead of trailing past it.
              <ol className="trk-steps">
                {steps.map((step, index) => (
                  <li key={step.key} className={`trk-step ${step.done ? "is-done" : ""}`}>
                    <span className="trk-rail" aria-hidden="true">
                      <span className="trk-mark">
                        {step.done ? (
                          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
                            <path d="m8 12.4 2.6 2.6L16 9.6" stroke="currentColor"
                              strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.6" />
                          </svg>
                        )}
                      </span>
                      {index < steps.length - 1 && (
                        <span className={`trk-connector ${steps[index + 1].done ? "is-done" : ""}`} />
                      )}
                    </span>
                    <span className="trk-step-text">
                      <span className="trk-step-name">{step.name}</span>
                      {step.at && <span className="trk-step-at">{when(step.at, lang)}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}

            {/* — Lines ———————————————————————————————————— */}
            <ul className="trk-items">
              {order.items.map((item, index) => (
                <li key={`${item.productId}-${index}`}>
                  <span>
                    {localized(lang, item.name, item.nameAr)}
                    {item.choice ? ` — ${localized(lang, item.choice.name, item.choice.nameAr)}` : ""} × {item.qty}
                    {item.selections?.length
                      ? ` (${item.selections
                          .map((pick) => `${pick.quantity}× ${localized(lang, pick.name, pick.nameAr)}`)
                          .join(", ")})`
                      : ""}
                  </span>
                  <span>{t.price(item.lineTotal)}</span>
                </li>
              ))}
            </ul>

            <button type="button" className="ed-ghost"
              onClick={() => { setResult(null); setPhone(""); setError(null); }}>
              {t.trAgain}
            </button>
          </div>
        )}

        <Link className="ed-ghost" href="/menu">{t.okContinue}</Link>
      </div>
    </main>
  );
}
