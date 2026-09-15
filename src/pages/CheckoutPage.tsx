import { cloneElement, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, api, newIdempotencyKey,
  type ApiProduct, type Order, type Settings,
} from "@/lib/api";
import { useCart } from "@/lib/cart";
import { lineKey } from "@/lib/cart-core";
import { choiceProblem, deliveryFee, unitPrice } from "../../shared/productPricing.mjs";
import { localized, useLang } from "@/lib/i18n";
import { Link, navigate } from "@/lib/router";
import ReceiptPrinter from "@/components/ReceiptPrinter";

/**
 * Checkout.
 *
 * The layout is Scooby's editorial checkout, ported: a rule-under-the-brand top
 * bar, a small-caps eyebrow over a large display title, then a 1.55fr/1fr grid
 * with the details form on the left and a sticky summary on the right. The
 * summary is a hairline rule under a small-caps heading rather than a bordered
 * card, and the inputs are underlines rather than boxes — that is the signature
 * of this layout and the thing that makes it read as editorial rather than as
 * an admin form. Class names are kept as `ed-*` so the two codebases stay
 * legible side by side; only the palette is Holland's.
 *
 * The page re-prices the cart against the live catalogue before it shows a
 * single figure, because the cart holds a display snapshot taken whenever the
 * customer added the item and the number beside Total is what they are agreeing
 * to pay. It still is not authoritative — nothing in a browser is. The server
 * prices the order again on receipt and refuses if its total differs from the
 * one shown here; `expectedTotal` is how that refusal is triggered. See
 * backend/orderTransaction.js.
 */

const FULFILMENTS = ["delivery", "pickup"] as const;

export default function CheckoutPage() {
  const { t, lang } = useLang();
  const { items, clear } = useCart();

  const [catalogue, setCatalogue] = useState<Map<string, ApiProduct> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState(false);

  const [form, setForm] = useState({
    firstName: "", lastName: "", phone: "", email: "",
    fulfilment: "delivery" as (typeof FULFILMENTS)[number],
    area: "", address: "", building: "", floor: "", apartment: "",
    landmark: "", notes: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [placed, setPlaced] = useState<Order | null>(null);

  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<{ code: string; discount: number } | null>(null);
  const [promoMsg, setPromoMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  // The subtotal the applied code was checked against, and a counter so only
  // the newest check may write. See the re-check effect below `totals`.
  const promoSubtotal = useRef<number | null>(null);
  const promoCheck = useRef(0);

  /**
   * Generated once for the life of this form, not per submit — which is what
   * makes it useful. A double-tapped button, or a request the network ate and
   * the browser retried, arrives twice carrying the same key and produces one
   * order. A key regenerated per attempt would make every retry a new order.
   */
  const idempotencyKey = useRef(newIdempotencyKey());
  // Read synchronously by `submit`. A double tap delivers both clicks before
  // React re-renders with `submitting`, so the state alone lets two through.
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.menu(), api.settings()])
      .then(([menu, config]) => {
        if (cancelled) return;
        const map = new Map<string, ApiProduct>();
        for (const category of menu.categories) {
          for (const product of category.items) map.set(product.id, product);
        }
        setCatalogue(map);
        setSettings(config.settings);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  /**
   * The cart, re-priced. A line whose product has vanished or sold out is
   * surfaced rather than silently dropped — the customer put it there and is
   * entitled to know it is not coming.
   */
  const lines = useMemo(() => {
    if (!catalogue) return [];
    return items.map((item) => {
      const product = catalogue.get(item.productId);
      const unit = product ? unitPrice(product, item.selections) : item.price;
      const pickSoldOut = (item.selections ?? []).some((pick) =>
        product?.groups?.[pick.group]?.options
          .find((option) => option.productId === pick.productId)?.available === false);
      const option = product?.choices?.find((entry) => entry.name === item.choice);
      return {
        ...item,
        key: lineKey(item),
        name: product ? localized(lang, product.name, product.nameAr) : item.name,
        choiceLabel: option ? localized(lang, option.name, option.nameAr) : item.choiceLabel,
        note: product?.note ? localized(lang, product.note, product.noteAr) : item.note,
        image: product?.image,
        unitPrice: unit,
        lineTotal: unit * item.qty,
        // An option since removed, or options added since, leave a line the
        // kitchen can no longer take as it stands.
        gone: !product || choiceProblem(product, item.choice) !== null,
        soldOut: !!product && (!product.available || pickSoldOut),
      };
    });
  }, [items, catalogue, lang]);

  const blocked = lines.filter((line) => line.gone || line.soldOut);
  const count = lines.reduce((sum, line) => sum + line.qty, 0);

  const totals = useMemo(() => {
    const raw = lines
      .filter((line) => !line.gone && !line.soldOut)
      .reduce((sum, line) => sum + line.lineTotal, 0);
    const subtotal = Math.round(raw * 100) / 100;
    const discount = Math.min(promo?.discount ?? 0, subtotal);
    // The server's own function rather than a copy of it: free delivery starts
    // at exactly the threshold on both sides, or an order at that figure would
    // be refused as a price change.
    const delivery = deliveryFee(subtotal, settings, form.fulfilment);
    return {
      subtotal, discount, delivery,
      total: Math.round((subtotal - discount + delivery) * 100) / 100,
    };
  }, [lines, promo, form.fulfilment, settings]);

  // A code's discount was worked out against the subtotal it was checked with.
  // When the subtotal moves afterwards (the catalogue re-priced after a refusal,
  // or a line sold out) the code is checked again. Without this the page kept
  // the old discount, sent a total the server could not reproduce, and was
  // refused with "prices changed" on every retry.
  const genericError = useRef(t.ckGenericError);
  genericError.current = t.ckGenericError;
  useEffect(() => {
    if (!promo || promoSubtotal.current === null || promoSubtotal.current === totals.subtotal) return;
    const token = ++promoCheck.current;
    const subtotal = totals.subtotal;
    promoSubtotal.current = subtotal;
    api.validatePromo(promo.code, subtotal)
      .then((result) => {
        if (token === promoCheck.current) setPromo(result);
      })
      .catch((error) => {
        if (token !== promoCheck.current) return;
        setPromo(null);
        promoSubtotal.current = null;
        setPromoMsg({ text: error instanceof ApiError ? error.message : genericError.current, ok: false });
      });
  }, [promo, totals.subtotal]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    // Cleared on edit rather than on submit: an error still showing under a
    // field the customer has already fixed reads as the fix not having worked.
    setFieldErrors((current) => {
      if (!current[key as string]) return current;
      const next = { ...current };
      delete next[key as string];
      return next;
    });
  }

  async function applyPromo() {
    const code = promoInput.trim();
    if (!code) return;
    // The cart has to be priced before a discount off it can mean anything.
    // The button is disabled until then; this is the second line, because the
    // gap is a race and a disabled attribute is a render behind the state.
    if (!catalogue || totals.subtotal <= 0) return;
    setPromoBusy(true);
    setPromoMsg(null);
    // A re-check of the previous code still in flight must not land on this one.
    promoCheck.current += 1;
    try {
      const result = await api.validatePromo(code, totals.subtotal);
      promoSubtotal.current = totals.subtotal;
      setPromo(result);
      setPromoInput("");
      setPromoMsg({ text: t.ckPromoApplied(result.code), ok: true });
    } catch (error) {
      setPromo(null);
      promoSubtotal.current = null;
      setPromoMsg({
        text: error instanceof ApiError ? error.message : t.ckGenericError,
        ok: false,
      });
    } finally {
      setPromoBusy(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current || !items.length) return;
    // Not until the catalogue has arrived. `lines` is derived from it and is
    // empty until it lands, so submitting early sends an empty items array and
    // the server answers, correctly and very confusingly, "Your cart is empty"
    // to somebody looking at a cart with things in it. `items.length` above does
    // not catch this: the cart is genuinely full, it is the *priced* cart that
    // is not ready.
    if (!catalogue) return;
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const { order } = await api.placeOrder({
        idempotencyKey: idempotencyKey.current,
        // Identity and quantity only. Nothing about money leaves this page
        // except `expectedTotal`, which can only cause a refusal.
        items: lines
          .filter((line) => !line.gone && !line.soldOut)
          .map((line) => ({
            productId: line.productId,
            qty: line.qty,
            ...(line.choice ? { choice: line.choice } : {}),
            ...(line.selections?.length
              ? {
                  selections: line.selections.map(({ group, productId, quantity }) => ({
                    group, productId, quantity,
                  })),
                }
              : {}),
          })),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim() || undefined,
        phone: form.phone.trim(),
        email: form.email.trim() || undefined,
        fulfilment: form.fulfilment,
        area: form.area || undefined,
        address: form.address.trim() || undefined,
        building: form.building.trim() || undefined,
        floor: form.floor.trim() || undefined,
        apartment: form.apartment.trim() || undefined,
        landmark: form.landmark.trim() || undefined,
        notes: form.notes.trim() || undefined,
        promoCode: promo?.code,
        lang,
        expectedTotal: totals.total,
      });
      // Cleared only once the order exists. Clearing optimistically would
      // destroy the basket of anyone whose order was refused.
      clear();
      setPlaced(order);
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.fields) setFieldErrors(error.fields);
        if (error.code === "PRICE_CHANGED") {
          setFormError(t.ckPriceChanged);
          // Re-fetch so the summary shows the prices the refusal was about,
          // rather than leaving the customer staring at the stale ones.
          api.menu().then((menu) => {
            const map = new Map<string, ApiProduct>();
            for (const category of menu.categories) {
              for (const product of category.items) map.set(product.id, product);
            }
            setCatalogue(map);
          }).catch(() => {});
        } else if (error.code === "CLOSED") setFormError(t.ckClosed);
        else if (!error.fields) setFormError(error.message);
      } else {
        setFormError(t.ckGenericError);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (placed) return <ReceiptPrinter order={placed} />;

  const delivering = form.fulfilment === "delivery";

  return (
    <main className="ed-page">
      <div className="ed-shell">

        {!items.length ? (
          <div className="ed-empty">
            <span className="ed-tag">{t.ckTitle}</span>
            <h1 className="ed-title">{t.ckEmptyTitle}</h1>
            <p className="ed-note">{t.ckEmptyBody}</p>
            <Link className="ed-btn" href="/menu">{t.cartEmptyCta}</Link>
          </div>
        ) : (
          <>
            <button type="button" className="ed-back" onClick={() => navigate("/menu")}>
              <span aria-hidden="true">←</span> {t.ckBackToCart}
            </button>
            <span className="ed-tag">{t.ckTitle}</span>
            <h1 className="ed-title">{t.ckYourDetails}</h1>

            {loadError && <p className="ed-alert" role="alert">{t.ckGenericError}</p>}
            {settings && !settings.acceptingOrders && (
              <p className="ed-alert" role="alert">{t.ckClosed}</p>
            )}

            <div className="ed-grid">
              <form onSubmit={submit} noValidate>
                <div className="ed-2col">
                  <Field id="firstName" label={t.ckFirstName} error={fieldErrors.firstName} required>
                    <input id="firstName" className="ed-input" autoComplete="given-name"
                      value={form.firstName} onChange={(e) => set("firstName", e.target.value)} />
                  </Field>
                  <Field id="lastName" label={t.ckLastName} error={fieldErrors.lastName}>
                    <input id="lastName" className="ed-input" autoComplete="family-name"
                      value={form.lastName} onChange={(e) => set("lastName", e.target.value)} />
                  </Field>
                </div>

                <div className="ed-2col">
                  <Field id="email" label={t.ckEmail} error={fieldErrors.email}>
                    <input id="email" className="ed-input" type="email" inputMode="email" dir="ltr"
                      autoComplete="email" value={form.email}
                      onChange={(e) => set("email", e.target.value)} />
                  </Field>
                  {/* dir="ltr": a phone number typed into an RTL field has its
                      leading + moved to the far end by the bidi algorithm. */}
                  <Field id="phone" label={t.ckPhone} error={fieldErrors.phone} required>
                    <input id="phone" className="ed-input" type="tel" inputMode="tel" dir="ltr"
                      autoComplete="tel" placeholder="010 1234 5678" value={form.phone}
                      onChange={(e) => set("phone", e.target.value)} />
                  </Field>
                </div>

                <div className="ed-field">
                  <span className="ed-label">{t.ckHowTitle}</span>
                  <div className="ed-choice" role="radiogroup" aria-label={t.ckHowTitle}>
                    {FULFILMENTS.map((option) => (
                      <button key={option} type="button" role="radio"
                        aria-checked={form.fulfilment === option}
                        className={form.fulfilment === option ? "active" : ""}
                        onClick={() => set("fulfilment", option)}>
                        {option === "delivery" ? t.ckDelivery : t.ckPickup}
                      </button>
                    ))}
                  </div>
                </div>

                {delivering ? (
                  <>
                    <Field id="area" label={t.ckArea} error={fieldErrors.area} required>
                      <select id="area" className="ed-select" value={form.area}
                        onChange={(e) => set("area", e.target.value)}>
                        <option value="">{t.ckAreaPlaceholder}</option>
                        {settings?.areas.map((area) => (
                          <option key={area.id} value={area.id}>
                            {localized(lang, area.name, area.nameAr)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field id="address" label={t.ckAddress} error={fieldErrors.address} required>
                      <textarea id="address" className="ed-textarea" rows={2}
                        autoComplete="street-address" value={form.address}
                        onChange={(e) => set("address", e.target.value)} />
                    </Field>
                    <div className="ed-2col">
                      <Field id="building" label={t.ckBuilding}>
                        <input id="building" className="ed-input" value={form.building}
                          onChange={(e) => set("building", e.target.value)} />
                      </Field>
                      <Field id="floor" label={t.ckFloor}>
                        <input id="floor" className="ed-input" value={form.floor}
                          onChange={(e) => set("floor", e.target.value)} />
                      </Field>
                    </div>
                    <div className="ed-2col">
                      <Field id="apartment" label={t.ckApartment}>
                        <input id="apartment" className="ed-input" value={form.apartment}
                          onChange={(e) => set("apartment", e.target.value)} />
                      </Field>
                      <Field id="landmark" label={t.ckLandmark}>
                        <input id="landmark" className="ed-input" value={form.landmark}
                          onChange={(e) => set("landmark", e.target.value)} />
                      </Field>
                    </div>
                  </>
                ) : (
                  <p className="ed-note">{t.ckPickupNote}</p>
                )}

                <Field id="notes" label={t.ckNotes}>
                  <textarea id="notes" className="ed-textarea" rows={2}
                    placeholder={t.ckNotesPlaceholder} value={form.notes}
                    onChange={(e) => set("notes", e.target.value)} />
                </Field>

                <div className="ed-field" style={{ marginBlockStart: 34 }}>
                  <span className="ed-label">{t.ckPayment}</span>
                  {/* One method, and it is stated rather than offered as a
                      choice between one thing. A card option that opened
                      nothing would be a lie. */}
                  <div className="ed-pay">
                    <label className="active">
                      <input type="radio" name="payment" value="cash" checked readOnly />
                      {/* Delivery is paid to the driver, pickup at the counter.
                          Saying "cash on delivery" over a pickup order names a
                          person who is never going to turn up. */}
                      <span className="ed-pay-label">
                        {delivering ? t.ckPayCash : t.ckPayPickup}
                      </span>
                      <span className="ed-pay-sub">
                        {delivering ? t.ckPayCashNote : t.ckPayPickupNote}
                      </span>
                    </label>
                  </div>
                </div>

                {formError && <p className="ed-alert" role="alert">{formError}</p>}

                <button type="submit" className="ed-btn"
                  disabled={submitting || !catalogue || !!blocked.length
                    || settings?.acceptingOrders === false}>
                  {submitting ? t.ckPlacing : t.ckPlaceOrder}
                </button>
                <p className="ed-fine">{t.cartHandoffNote}</p>
              </form>

              <aside className="ed-summary" aria-label={t.ckSummary}>
                <h3>{t.ckSummary} ({count})</h3>

                {lines.map((line) => (
                  <div key={line.key}
                    className={`ed-sum-item ${line.gone || line.soldOut ? "is-gone" : ""}`}>
                    <div className="ed-sum-thumb">
                      {line.image
                        ? <img src={line.image} alt="" loading="lazy" decoding="async" />
                        : <span aria-hidden="true">🍪</span>}
                    </div>
                    <div className="ed-sum-info">
                      <span>{line.name}</span>
                      {line.choiceLabel ? <small>{line.choiceLabel}</small> : null}
                      {line.selections?.length ? (
                        <small>
                          {line.selections.map((pick) => `${pick.quantity}× ${pick.name}`).join(", ")}
                        </small>
                      ) : null}
                      <small>
                        {line.qty} × {t.price(line.unitPrice)}
                        {line.note ? ` · ${line.note}` : ""}
                      </small>
                    </div>
                    <span className="ed-sum-price">{t.price(line.lineTotal)}</span>
                  </div>
                ))}

                <div className="ed-promo">
                  <div className="ed-field">
                    <label className="ed-label" htmlFor="promo">{t.ckPromo}</label>
                    <input id="promo" className="ed-input" dir="ltr" value={promoInput}
                      onChange={(e) => setPromoInput(e.target.value)} />
                  </div>
                  {/* Also disabled until the catalogue has arrived. `lines` is
                      empty while it is loading, so the subtotal is 0 — and a
                      promo validated against a subtotal of 0 comes back with a
                      discount of 0, correctly and uselessly. The customer then
                      sees "CODE applied" above a total that never moved. It
                      needs a real subtotal to be a real answer. */}
                  <button type="button" className="ed-apply" onClick={applyPromo}
                    disabled={promoBusy || !promoInput.trim() || !catalogue}>
                    {t.ckPromoApply}
                  </button>
                </div>
                {promoMsg && (
                  <p className={`ed-promo-msg ${promoMsg.ok ? "ok" : "bad"}`}>{promoMsg.text}</p>
                )}

                <div style={{ marginBlockStart: 20 }}>
                  <div className="ed-srow">
                    <span>{t.cartSubtotal}</span><span>{t.price(totals.subtotal)}</span>
                  </div>
                  {totals.discount > 0 && (
                    <div className="ed-srow discount">
                      <span>{t.ckPromo}</span><span>−{t.price(totals.discount)}</span>
                    </div>
                  )}
                  <div className="ed-srow">
                    <span>{t.ckDelivery}</span><span>{t.price(totals.delivery)}</span>
                  </div>
                  <div className="ed-srow total">
                    <span>{t.ckTotal}</span><span>{t.price(totals.total)}</span>
                  </div>
                </div>
              </aside>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/**
 * A labelled field.
 *
 * The error is wired with `aria-describedby` and `aria-invalid` rather than
 * only being painted — a colour change is not available to a screen reader.
 * Those attributes are cloned onto the control itself rather than set on a
 * wrapper, which is the whole point: `aria-describedby` on a `<div>` describes
 * the div, and nothing is focused on it.
 */
function Field({
  id, label, hint, error, required, children,
}: {
  id: string; label: string; hint?: string; error?: string;
  required?: boolean; children: React.ReactElement;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const control = cloneElement(
    children as React.ReactElement<Record<string, unknown>>,
    {
      "aria-describedby": describedBy,
      "aria-invalid": error ? true : undefined,
      "aria-required": required || undefined,
    },
  );

  return (
    <div className={`ed-field ${error ? "has-error" : ""}`}>
      <label className="ed-label" htmlFor={id}>{label}</label>
      {control}
      {hint && <p className="ed-note" id={hintId}>{hint}</p>}
      {error && <p className="ed-error" id={errorId} role="alert">{error}</p>}
    </div>
  );
}
