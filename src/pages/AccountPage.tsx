import { useEffect, useRef, useState } from "react";
import { ApiError, api, type AccountOrder, type Settings } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { localized, useLang, type Translations } from "@/lib/i18n";
import { Link } from "@/lib/router";
import SignInSheet from "@/components/SignInSheet";
import { parseStamp, SHOP_TIME_ZONE } from "@/lib/dates";

/**
 * Your account.
 *
 * Signed out, this is the sign-in sheet. Signed in, it is the customer's own
 * details and every order they have placed — including the ones placed as a
 * guest before the account existed, which the server attached the moment the
 * email was proved. See `claimProfile` in backend/customerAuth.js.
 *
 * The history here is keyed on the account, not on a phone number typed into a
 * form. That is the difference between this page and `/track`, which stays for
 * customers who never sign in.
 *
 * Uses the same `ed-*` layer as the checkout.
 */

const STATUS_KEY: Record<string, keyof Translations> = {
  ordered: "stPending",
  confirmed: "stConfirmed",
  baking: "stBaking",
  in_transit: "stOutForDelivery",
  completed: "stCompleted",
  cancelled: "stCancelled",
};

export default function AccountPage() {
  const { t, lang } = useLang();
  const { customer, ready, signOut, update, accountsEnabled } = useAuth();

  const [orders, setOrders] = useState<AccountOrder[] | null>(null);
  const [linked, setLinked] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    fullName: "", phone: "", defaultArea: "", defaultAddress: "",
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaved, setProfileSaved] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);

  // The delivery areas, so "usual area" can be chosen from the same list the
  // checkout offers. Orders store the area *id*, so without this the field
  // showed `nasr-city` rather than Nasr City — the id, not the name.
  useEffect(() => {
    let active = true;
    api.settings()
      .then((result) => { if (active) setSettings(result.settings); })
      .catch(() => { /* the field falls back to a free-text input */ });
    return () => { active = false; };
  }, []);

  /**
   * Seeded from the account — including the backfill the server does from the
   * most recent order on a first sign-in, so the form arrives filled in rather
   * than blank.
   *
   * **Never over something the customer is typing.** This used to run on every
   * change of the `customer` object, and the session is re-read in the
   * background: a refresh landing between the first keystroke and the Save
   * button put the stored values back into the fields, and the save then sent
   * the old name and reported "Saved." — the edit was gone and the page said it
   * had worked. Caught by the account e2e on WebKit, where that refresh happens
   * to land in the gap; it was luck rather than correctness that it did not on
   * Chromium.
   *
   * So the form is seeded once per signed-in account, and again only after a
   * save has been stored — never while there are unsaved edits in it.
   */
  const seededFor = useRef<string | null>(null);
  const edited = useRef(false);
  useEffect(() => {
    if (!customer) {
      seededFor.current = null;
      edited.current = false;
      return;
    }
    // A different account is a different form; whatever was half-typed in the
    // last one is not theirs to inherit.
    const sameAccount = seededFor.current === customer.email;
    if (sameAccount && edited.current) return;
    seededFor.current = customer.email;
    edited.current = false;
    setForm({
      fullName: customer.fullName,
      phone: customer.phone,
      defaultArea: customer.defaultArea,
      defaultAddress: customer.defaultAddress,
    });
  }, [customer]);

  /** Every field goes through this, so "has this been touched" cannot go stale. */
  const editField = (patch: Partial<typeof form>) => {
    edited.current = true;
    setForm((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    if (!customer) { setOrders(null); return; }
    let active = true;
    api.accountOrders()
      .then((result) => { if (active) setOrders(result.orders); })
      .catch((caught) => {
        if (active) setError(caught instanceof ApiError ? caught.message : t.ckGenericError);
      });
    return () => { active = false; };
  }, [customer, t]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    if (savingProfile) return;
    setSavingProfile(true);
    setProfileSaved(false);
    setError(null);
    try {
      const result = await api.updateProfile(form);
      // Saved, so there is nothing unsaved left to protect and the account may
      // seed the form again.
      edited.current = false;
      update(result.customer);
      setProfileSaved(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : t.ckGenericError);
    } finally {
      setSavingProfile(false);
    }
  }

  // Nothing at all until the session has been read. A flash of the sign-in form
  // before the cookie comes back would make every reload look like a logout.
  if (!ready) return <main className="ed-page"><div className="ed-shell ed-placed" /></main>;

  if (!customer) {
    return (
      <main className="ed-page">
        <div className="ed-shell ed-placed">
          {accountsEnabled ? (
            <SignInSheet onDone={setLinked} />
          ) : (
            <>
              <span className="ed-tag">{t.acSignInTitle}</span>
              <p className="ed-note" role="status">{t.acUnavailable}</p>
            </>
          )}

          <hr style={{ margin: "44px 0 26px", border: 0, borderTop: "1px solid rgb(93 16 29 / 0.12)" }} />

          {/* Signing in is not the only way to find an order, and saying so
              here is what stops the account becoming a wall in front of the one
              thing most people came for. */}
          <span className="ed-tag">{t.acGuestTitle}</span>
          <p className="ed-note" style={{ marginBlockEnd: 10 }}>{t.acGuestIntro}</p>
          <Link className="ed-ghost" href="/track">{t.okTrack}</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="ed-page">
      <div className="ed-shell ed-placed">
        <span className="ed-tag">{t.acSignedInAs}</span>
        <h1 className="ed-title" style={{ marginBlockEnd: 8 }}>{t.acTitle}</h1>
        <p className="ed-note" dir="ltr" style={{ marginBlockStart: 0 }}>{customer.email}</p>

        {linked > 0 && (
          <p className="ed-promo-msg ok" style={{ marginBlockStart: 14 }} role="status">
            {t.acLinked(linked)}
          </p>
        )}
        {error && <p className="ed-alert" role="alert" style={{ marginBlockStart: 16 }}>{error}</p>}

        {/* — Details ————————————————————————————————————— */}
        <form onSubmit={saveProfile} noValidate style={{ marginBlockStart: 40 }}>
          <span className="ed-tag">{t.acProfile}</span>
          <p className="ed-note" style={{ marginBlockEnd: 20 }}>{t.acProfileHint}</p>

          <div className="ed-2col">
            <div className="ed-field">
              <label className="ed-label" htmlFor="ac-name">{t.acFullName}</label>
              <input id="ac-name" className="ed-input" autoComplete="name" value={form.fullName}
                onChange={(event) => editField({ fullName: event.target.value })} />
            </div>
            <div className="ed-field">
              <label className="ed-label" htmlFor="ac-phone">{t.acProfilePhone}</label>
              <input id="ac-phone" className="ed-input" type="tel" inputMode="tel" dir="ltr"
                autoComplete="tel" value={form.phone}
                onChange={(event) => editField({ phone: event.target.value })} />
            </div>
          </div>

          <div className="ed-field">
            <label className="ed-label" htmlFor="ac-area">{t.acProfileArea}</label>
            {settings ? (
              <select id="ac-area" className="ed-select" value={form.defaultArea}
                onChange={(event) => editField({ defaultArea: event.target.value })}>
                <option value="">{t.ckAreaPlaceholder}</option>
                {settings.areas.map((area) => (
                  <option key={area.id} value={area.id}>
                    {localized(lang, area.name, area.nameAr)}
                  </option>
                ))}
              </select>
            ) : (
              // Until the list loads — or if it fails — the stored value stays
              // editable rather than the field disappearing.
              <input id="ac-area" className="ed-input" value={form.defaultArea}
                onChange={(event) => editField({ defaultArea: event.target.value })} />
            )}
          </div>
          <div className="ed-field">
            <label className="ed-label" htmlFor="ac-address">{t.acProfileAddress}</label>
            <input id="ac-address" className="ed-input" autoComplete="street-address"
              value={form.defaultAddress}
              onChange={(event) => editField({ defaultAddress: event.target.value })} />
          </div>

          {profileSaved && <p className="ed-promo-msg ok" role="status">{t.acProfileSaved}</p>}

          <button type="submit" className="ed-btn" disabled={savingProfile}>
            {savingProfile ? t.acSavingProfile : t.acSaveProfile}
          </button>
        </form>

        {/* — History —————————————————————————————————————— */}
        <div style={{ marginBlockStart: 48 }}>
          <span className="ed-tag">{t.acHistory}</span>
          {!orders ? null : orders.length === 0 ? (
            <p className="ed-note">{t.acHistoryEmpty}</p>
          ) : (
            orders.map((order) => {
              const pieces = order.items.reduce((n, item) => n + item.qty, 0);
              return (
                <div key={order.reference} className="ed-order">
                  <div className="ed-order-head">
                    <span className="ed-order-ref" dir="ltr">{order.reference}</span>
                    <span className={`ed-order-status is-${order.status}`}>
                      {t[STATUS_KEY[order.status] ?? "stPending"] as string}
                    </span>
                  </div>
                  <p className="ed-order-meta">
                    {parseStamp(order.createdAt).toLocaleDateString(
                      lang === "ar" ? "ar-EG" : "en-GB",
                      { day: "numeric", month: "short", year: "numeric", timeZone: SHOP_TIME_ZONE },
                    )}
                    {" · "}
                    {t.cartPieces(pieces)}
                  </p>
                  <p className="ed-order-items">
                    {order.items
                      .map((item) => `${item.qty}× ${localized(lang, item.name, item.nameAr)}${
                        item.choice ? ` — ${localized(lang, item.choice.name, item.choice.nameAr)}` : ""
                      }`)
                      .join(lang === "ar" ? "، " : ", ")}
                  </p>
                  <div className="ed-order-foot">
                    <strong>{t.price(order.totals.total)}</strong>
                    <Link href={`/track?ref=${encodeURIComponent(order.reference)}`}>
                      {t.acView}
                    </Link>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <button type="button" className="ed-ghost" style={{ marginBlockStart: 36 }}
          onClick={() => { void signOut(); }}>
          {t.acSignOut}
        </button>
        <Link className="ed-ghost" href="/menu">{t.okContinue}</Link>
      </div>
    </main>
  );
}
