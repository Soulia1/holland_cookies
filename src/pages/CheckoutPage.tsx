import { cloneElement, Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError, api, newIdempotencyKey,
  type ApiProduct, type Order, type PaymentSession, type Settings,
} from "@/lib/api";
import { useCart } from "@/lib/cart";
import { lineKey } from "@/lib/cart-core";
import { areaFee, choiceProblem, deliveryFee, unitPrice } from "../../shared/productPricing.mjs";
import { areasByCity } from "../../shared/deliveryAreas.mjs";
import { localized, useLang } from "@/lib/i18n";
import { Link } from "@/lib/router";
import { itemImage } from "@/data/menuImages";
import { leadDaysForCategory } from "@/data/menu";
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
const PENDING_PAYMENT = "holland.pending-payment";

function rememberPayment(reference: string, phone: string) {
  sessionStorage.setItem(PENDING_PAYMENT, JSON.stringify({ reference, phone }));
}

function openHostedCheckout(session: PaymentSession) {
  const url = new URL(session.checkoutUrl, window.location.origin);
  const mock = url.origin === window.location.origin && url.pathname === "/api/payments/mock/checkout";
  if (!mock && url.origin !== "https://eg.checkout.paymob.com") throw new Error("Invalid payment URL");
  window.location.assign(url.href);
}

export default function CheckoutPage() {
  const { t, lang } = useLang();
  const { items, clear, remove, setOpen: openCart } = useCart();

  const [catalogue, setCatalogue] = useState<Map<string, ApiProduct> | null>(null);
  /** Category id → the menu page it is shown on, which is where a lead time lives. */
  const [categoryPages, setCategoryPages] = useState<Map<string, string | undefined>>(new Map());
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
  const [restoringPayment, setRestoringPayment] = useState(() => !!sessionStorage.getItem(PENDING_PAYMENT));
  const [payMethod, setPayMethod] = useState<"cash" | "online">("cash");
  /**
   * An online order that exists but is not paid yet. From here the form is
   * gone: the order is committed, and a second submit would be a second order.
   */
  const [awaiting, setAwaiting] = useState<{
    order: Order; phone: string; session: PaymentSession | null; open: boolean; error: string | null;
  } | null>(null);

  useEffect(() => {
    let active = true;
    const raw = sessionStorage.getItem(PENDING_PAYMENT);
    if (!raw) { setRestoringPayment(false); return; }
    let saved: { reference: string; phone: string };
    try {
      saved = JSON.parse(raw);
      if (!/^HC-\d{1,16}$/.test(saved.reference) || typeof saved.phone !== "string") throw new Error("Invalid saved order");
    } catch {
      sessionStorage.removeItem(PENDING_PAYMENT);
      setRestoringPayment(false);
      return;
    }
    api.trackOrder(saved.reference, saved.phone).then(({ order }) => {
      if (!active) return;
      const declined = new URLSearchParams(window.location.search).get("payment_result") === "declined";
      setAwaiting({ order, phone: saved.phone, session: null, open: false, error: declined ? t.payDeclined : null });
      setRestoringPayment(false);
      // Remove provider result hints once the tab has resumed the saved order.
      if (new URLSearchParams(window.location.search).has("payment_return")) {
        window.history.replaceState(null, "", "/checkout");
      }
    }).catch(() => {
      // Keep the saved reference: retrying the lookup must not place a second order.
      if (active) setLoadError(true);
    });
    return () => { active = false; };
  }, [t.payDeclined]);

  useEffect(() => {
    if (!awaiting) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const result = await api.paymentStatus(awaiting.order.reference, awaiting.phone);
        if (!active) return;
        if (result.paymentStatus === "paid") {
          clear();
          sessionStorage.removeItem(PENDING_PAYMENT);
          setPlaced({ ...awaiting.order, paymentStatus: "paid" });
          setAwaiting(null);
          return;
        }
        if (result.paymentStatus === "refunded" || result.status === "cancelled") {
          setAwaiting((current) => current && current.order.paymentStatus === result.paymentStatus
            && current.order.status === result.status ? current : current && {
            ...current, order: { ...current.order, paymentStatus: result.paymentStatus, status: result.status },
            error: result.paymentStatus === "refunded" ? t.payRefunded : t.payCancelled,
          });
          return;
        }
        if (result.paymentOutcome === "declined") {
          setAwaiting((current) => current && current.error === null ? { ...current, error: t.payDeclined } : current);
        }
      } catch { /* The next poll retries a missed request. */ }
      if (active) timer = setTimeout(check, 3000);
    };
    void check();
    return () => { active = false; clearTimeout(timer); };
  }, [awaiting, clear, t.payDeclined, t.payRefunded, t.payCancelled]);

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
        const pages = new Map<string, string | undefined>();
        for (const category of menu.categories) {
          pages.set(category.id, category.group);
          for (const product of category.items) map.set(product.id, product);
        }
        setCatalogue(map);
        setCategoryPages(pages);
        setSettings(config.settings);
      })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, []);

  /** How many working days each line needs, by the page its category is on. */
  const leadDaysOf = (product: ApiProduct | undefined) =>
    (product ? leadDaysForCategory(product.categoryId, categoryPages.get(product.categoryId)) : 0);

  /** The delivery areas as the select renders them: one group per governorate. */
  const areaGroups = useMemo(() => areasByCity(settings?.areas), [settings]);

  /**
   * The cart, re-priced. A line whose product has vanished or sold out is
   * surfaced rather than silently dropped — the customer put it there and is
   * entitled to know it is not coming.
   */
  const lines = useMemo(() => {
    if (!catalogue) return [];
    return items.map((item) => {
      const product = catalogue.get(item.productId);
      const unit = product ? unitPrice(product, item.selections, item.choice) : item.price;
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
        // The photo the menu shows: one uploaded in the dashboard, else the
        // bundled menu photo, else what the cart kept. Only the upload was read,
        // so every product still on its bundled photo showed a placeholder here.
        image: product?.image || itemImage(item.productId) || item.image,
        leadDays: leadDaysOf(product),
        unitPrice: unit,
        lineTotal: unit * item.qty,
        // An option since removed, or options added since, leave a line the
        // kitchen can no longer take as it stands.
        gone: !product || choiceProblem(product, item.choice) !== null,
        soldOut: !!product && (!product.available || pickSoldOut),
      };
    });
  }, [items, catalogue, categoryPages, lang]);

  /** The lines that hold the order up, each name said once. See CartDrawer. */
  const leadLines = Object.values(Object.fromEntries(
    lines
      .filter((line) => line.leadDays > 0 && !line.gone && !line.soldOut)
      .map((line) => [line.name, { key: line.key, name: line.name, days: line.leadDays }] as const),
  ));

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
    const delivery = deliveryFee(subtotal, settings, form.fulfilment, form.area);
    return {
      subtotal, discount, delivery,
      total: Math.round((subtotal - discount + delivery) * 100) / 100,
    };
  }, [lines, promo, form.fulfilment, form.area, settings]);

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
    const online = payMethod === "online" && !!settings?.onlinePaymentEnabled;
    if (online && !form.email.trim()) {
      setFieldErrors({ email: t.ckPayOnlineEmail });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    setFieldErrors({});

    try {
      const { order, payment } = await api.placeOrder({
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
        paymentMethod: online ? "online" : "cash",
        lang,
        expectedTotal: totals.total,
      });
      if (order.paymentMethod === "online" && order.paymentStatus !== "paid") {
        // The basket stays until the money does: an order abandoned at the
        // payment page should not also cost the customer their cart.
        setAwaiting({
          order, phone: form.phone.trim(), session: payment ?? null,
          open: !!payment, error: payment ? null : t.payOpenFailed,
        });
        rememberPayment(order.reference, form.phone.trim());
        if (payment) openHostedCheckout(payment);
        window.scrollTo({ top: 0 });
        return;
      }
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

  function paid() {
    if (!awaiting) return;
    clear();
    sessionStorage.removeItem(PENDING_PAYMENT);
    setPlaced({ ...awaiting.order, paymentStatus: "paid" });
    setAwaiting(null);
    window.scrollTo({ top: 0 });
  }

  /** A fresh Paymob session: after a decline, a closed popup, or a failed open. */
  async function retryPayment() {
    if (!awaiting) return;
    const { order, phone } = awaiting;
    setAwaiting({ ...awaiting, session: null, open: true, error: null });
    try {
      const { payment } = await api.paymentSession(order.reference, phone);
      setAwaiting((current) => current && { ...current, session: payment });
      rememberPayment(order.reference, phone);
      openHostedCheckout(payment);
    } catch (error) {
      // Paid in the meantime — by the webhook, or in another tab.
      if (error instanceof ApiError && error.code === "NOTHING_TO_PAY") {
        const status = await api.paymentStatus(order.reference, phone).catch(() => null);
        if (status?.paymentStatus === "paid") return paid();
      }
      setAwaiting((current) => current && {
        ...current, open: false,
        error: error instanceof ApiError ? error.message : t.payOpenFailed,
      });
    }
  }

  if (restoringPayment) return (
    <main className="ed-page"><div className="ed-shell"><div className="ed-empty">
      <p className="ed-note" role="status">{loadError ? t.payOpenFailed : t.payConfirming}</p>
      {loadError && <button type="button" className="ed-btn" onClick={() => window.location.reload()}>{t.payRetry}</button>}
    </div></div></main>
  );
  if (placed) return <ReceiptPrinter order={placed} />;

  if (awaiting) {
    return (
      <main className="ed-page">
        <div className="ed-shell">
          <div className="ed-empty">
            <span className="ed-tag">{t.ckTitle}</span>
            <h1 className="ed-title">{t.payPendingTitle(awaiting.order.reference)}</h1>
            <p className="ed-note">{t.payPendingBody}</p>
            {awaiting.error && <p className="ed-alert" role="alert">{awaiting.error}</p>}
            {awaiting.order.paymentStatus !== "refunded" && awaiting.order.status !== "cancelled" && <button type="button" className="ed-btn"
              disabled={awaiting.open && !awaiting.session}
              onClick={() => void retryPayment()}>
              {t.payContinue}
            </button>}
            {(awaiting.order.paymentStatus === "refunded" || awaiting.order.status === "cancelled") && (
              <button type="button" className="ed-btn" onClick={() => {
                sessionStorage.removeItem(PENDING_PAYMENT);
                setAwaiting(null);
              }}>{t.payNewOrder}</button>
            )}
          </div>
        </div>
      </main>
    );
  }

  const delivering = form.fulfilment === "delivery";
  const onlineOffered = !!settings?.onlinePaymentEnabled;
  const payingOnline = onlineOffered && payMethod === "online";

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
            <button type="button" className="ed-back" onClick={() => openCart(true)}>
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
                  <Field id="email" label={t.ckEmail} error={fieldErrors.email} required={payingOnline}>
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
                        {/* Grouped by governorate. Cairo and Giza together run
                            to nearly forty neighbourhoods, and a flat list of
                            forty gives a customer no way to tell which side of
                            the river an unfamiliar name is on. */}
                        {areaGroups.map((group) => {
                          const options = group.areas.map((area) => (
                            <option key={area.id} value={area.id}>
                              {/* The area's own delivery price, in the option
                                  itself: the fee changes when the area does,
                                  and a customer should see that before they
                                  pick rather than in the summary afterwards.
                                  Priced by the same function the server uses,
                                  the shop's default included. */}
                              {t.ckAreaOption(
                                localized(lang, area.name, area.nameAr),
                                t.price(areaFee(settings, area.id)),
                              )}
                            </option>
                          ));
                          // An unlabelled group is rendered bare: an
                          // `<optgroup>` with no label draws an empty heading.
                          return group.city ? (
                            <optgroup key={group.city} label={localized(lang, group.city, group.cityAr)}>
                              {options}
                            </optgroup>
                          ) : (
                            <Fragment key="ungrouped">{options}</Fragment>
                          );
                        })}
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
                  {/* Online appears only when the server says Paymob is
                      configured: a card option that opened nothing would be a
                      lie. Until then cash is stated, not offered. */}
                  <div className={`ed-pay ${onlineOffered ? "is-choice" : ""}`}
                    role={onlineOffered ? "radiogroup" : undefined}
                    aria-label={onlineOffered ? t.ckPayment : undefined}>
                    {/* Online first, because it is the one being offered; cash
                        stays selected by default, which is what most orders
                        still are. */}
                    {onlineOffered && (
                      <label className={`ed-pay-opt ${payingOnline ? "is-active" : ""}`}>
                        <span className="ed-pay-row">
                          <input type="radio" name="payment" value="online" checked={payingOnline}
                            onChange={() => setPayMethod("online")} />
                          <span className="ed-pay-text">
                            <span className="ed-pay-label">{t.ckPayOnline}</span>
                            <span className="ed-pay-sub">{t.ckPayOnlineNote}</span>
                          </span>
                          <PayBrands more={t.ckPayWallets} />
                        </span>
                        {/* Only under the selected option, as the reference
                            checkout does: an explanation of what the button is
                            about to do, where it is about to be needed. */}
                        {payingOnline && <span className="ed-pay-hint">{t.ckPayOnlineHint}</span>}
                      </label>
                    )}
                    <label className={`ed-pay-opt ${payingOnline ? "" : "is-active"}`}>
                      <span className="ed-pay-row">
                        <input type="radio" name="payment" value="cash" checked={!payingOnline}
                          onChange={() => setPayMethod("cash")} />
                        <span className="ed-pay-text">
                          {/* Delivery is paid to the driver, pickup at the counter.
                              Saying "cash on delivery" over a pickup order names a
                              person who is never going to turn up. */}
                          <span className="ed-pay-label">
                            {delivering ? t.ckPayCash : t.ckPayPickup}
                          </span>
                          <span className="ed-pay-sub">
                            {delivering ? t.ckPayCashNote : t.ckPayPickupNote}
                          </span>
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                {formError && <p className="ed-alert" role="alert">{formError}</p>}
                {/* Why the button below is disabled. Without it a customer with
                    a stale line — an option since removed, a sold-out cookie —
                    faced a dead button and no reason. */}
                {blocked.length > 0 && <p className="ed-alert" role="alert">{t.ckBlocked}</p>}

                <button type="submit" className="ed-btn"
                  disabled={submitting || !catalogue || !!blocked.length
                    || settings?.acceptingOrders === false}>
                  {submitting ? t.ckPlacing : payingOnline ? t.ckPlaceOrderPay : t.ckPlaceOrder}
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
                      {/* Short on the line, which already names the item; the
                          named sentence is over the totals below. */}
                      {line.leadDays ? (
                        <small className="ed-sum-lead">{t.cartLeadShort(line.leadDays)}</small>
                      ) : null}
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
                      {(line.gone || line.soldOut) && (
                        <small className="ed-sum-blocked">
                          {line.gone ? t.ckLineGone : t.ckLineSoldOut}
                        </small>
                      )}
                    </div>
                    {line.gone || line.soldOut ? (
                      <button type="button" className="ed-sum-remove"
                        aria-label={t.cartRemove(line.name)}
                        onClick={() => remove(line.key)}>
                        {t.ckLineRemove}
                      </button>
                    ) : (
                      <span className="ed-sum-price">{t.price(line.lineTotal)}</span>
                    )}
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

                {/* The same named sentence the cart carries, kept in front of
                    the customer at the last screen before they pay. */}
                {leadLines.length > 0 && (
                  <div className="ed-lead" role="note">
                    {leadLines.map(({ key, name, days }) => (
                      <p key={key}>{t.cartLeadNote(name, days)}</p>
                    ))}
                  </div>
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
 * What the online option accepts, as small marks on the right of the row —
 * the reassurance the reference checkout gives at exactly this moment.
 *
 * Drawn inline rather than fetched: the content policy allows images from this
 * origin only, and four tiny marks are not worth four requests or four files.
 * Which methods are actually live is decided by the integrations on the Paymob
 * account, so this stays at the level of "cards and wallets" and does not
 * promise a particular scheme.
 */
function PayBrands({ more }: { more: string }) {
  return (
    <span className="ed-pay-brands" aria-hidden="true">
      <span className="ed-pay-brand" title="Visa">
        <svg viewBox="0 0 34 12" width="30" height="11">
          <text x="17" y="10" textAnchor="middle" fontSize="11" fontWeight="700"
            fontStyle="italic" fontFamily="Georgia, serif" fill="#1434CB">VISA</text>
        </svg>
      </span>
      <span className="ed-pay-brand" title="Mastercard">
        <svg viewBox="0 0 34 20" width="30" height="18">
          <circle cx="14" cy="10" r="6.5" fill="#EB001B" />
          <circle cx="20" cy="10" r="6.5" fill="#F79E1B" fillOpacity="0.85" />
        </svg>
      </span>
      <span className="ed-pay-brand" title="Meeza">
        <svg viewBox="0 0 34 12" width="30" height="11">
          <text x="17" y="9.5" textAnchor="middle" fontSize="9" fontWeight="700"
            fontFamily="Georgia, serif" fill="#0B4E8A">meeza</text>
        </svg>
      </span>
      <span className="ed-pay-more">{more}</span>
    </span>
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
