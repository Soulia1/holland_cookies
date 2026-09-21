import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { api } from "@/lib/api";
import { useCart } from "@/lib/cart";
import { lineKey, type CartItem } from "@/lib/cart-core";
import { itemImage } from "@/data/menuImages";
import { useLang } from "@/lib/i18n";
import { leadDaysForProduct, useLiveMenu } from "@/lib/liveMenu";
import { Link, navigate } from "@/lib/router";

/**
 * The line's picture: the photo snapshotted when it was added, else the menu's
 * own photo. A chosen flavor's id is `<item>--<flavor>`, so it falls back to
 * the item it was picked from; a cart saved before lines carried a photo gets
 * the same fallback.
 */
function lineImage(line: CartItem): string | undefined {
  return line.image ?? itemImage(line.productId) ?? itemImage(line.productId.split("--")[0]);
}

/**
 * The cart.
 *
 * A side sheet on a desktop and a full-height sheet on a phone — one component,
 * the difference is entirely in the stylesheet. Radix Dialog was already a
 * dependency for the product modal, so the focus trap, the scroll lock, the
 * escape key and the `aria-modal` wiring all come for free and, more to the
 * point, behave identically to the dialog the site already has.
 *
 * It renders no prices of its own: every figure comes from `useCart`, which
 * gets them from `cart-core`. See the note at the top of `cart-core.ts` about
 * why the money in a cart line is a display snapshot and not the truth.
 */

export default function CartDrawer() {
  const { items, count, subtotal, open, setOpen, setQty, remove, clear } = useCart();
  // Read live rather than snapshotted onto the line when it was added: a lead
  // time is a fact about the shop, and a cart that has sat in storage since
  // before the shop set one must not promise what the kitchen no longer does.
  const live = useLiveMenu();
  const menu = live.status === "ready" ? live.menu : null;

  /**
   * The lines that hold the order up, each named once.
   *
   * By name rather than by line, so two sizes of the same made-to-order cookie
   * say it once: the customer is being told when their order can arrive, and
   * hearing it twice does not make it arrive sooner.
   */
  const leadLines = Object.values(Object.fromEntries(
    items
      .map((line) => ({ key: lineKey(line), name: line.name, days: leadDaysForProduct(menu, line.productId) }))
      .filter((line) => line.days > 0)
      .map((line) => [line.name, line] as const),
  ));
  const { t, lang } = useLang();
  // Asked each time the cart opens, so a customer learns ordering is paused here
  // rather than after filling in the whole checkout form. The server refuses the
  // order either way; this is only the earlier, kinder place to say so.
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    api.settings()
      .then((result) => { if (active) setClosed(result.settings.acceptingOrders === false); })
      .catch(() => { /* checkout checks again */ });
    return () => { active = false; };
  }, [open]);

  function goToCheckout() {
    // Closed first, then navigated. Leaving the drawer open across the
    // navigation would render it on top of the checkout it just sent the
    // customer to, with the page behind it still scroll-locked.
    setOpen(false);
    navigate("/checkout");
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="cart-overlay" />
        {/* `dir` is set on the panel as well as on the document because Radix
            portals it to the end of <body> — inside the document's direction,
            but outside the app subtree, which is where a future nested override
            would live. Stating it here keeps the sheet correct regardless. */}
        <Dialog.Content className="cart-panel" dir={lang === "ar" ? "rtl" : "ltr"}>
          <header className="cart-head">
            <div>
              <Dialog.Title className="cart-title">{t.cartTitle}</Dialog.Title>
              <p className="cart-count">{t.cartPieces(count)}</p>
            </div>
            <Dialog.Close className="cart-close btn" aria-label={t.cartClose}>
              <span aria-hidden="true">×</span>
            </Dialog.Close>
          </header>

          {/* Radix requires a description or an explicit opt-out; the empty
              state and the line list both say what this is far better than a
              sentence repeating the title would. */}
          <Dialog.Description className="sr-only">{t.cartHandoffNote}</Dialog.Description>

          {items.length === 0 ? (
            <div className="cart-empty">
              <p className="cart-empty-title">{t.cartEmptyTitle}</p>
              <p className="cart-empty-body">{t.cartEmptyBody}</p>
              <Link className="cart-empty-cta btn" href="/menu" onClick={() => setOpen(false)}>
                {t.cartEmptyCta}
              </Link>
            </div>
          ) : (
            <>
              <ul className="cart-lines">
                {items.map((line) => (
                  <li key={lineKey(line)} className="cart-line">
                    {/* `alt=""`: the name sits right beside it. Every line gets
                        the box, photographed or not, so the column stays even. */}
                    <span className="cart-line-media" aria-hidden="true">
                      {lineImage(line) ? (
                        <img src={lineImage(line)} alt="" width={56} height={56} loading="lazy" decoding="async" />
                      ) : (
                        <svg viewBox="0 0 24 24" focusable="false">
                          <circle cx="12" cy="12" r="9" />
                        </svg>
                      )}
                    </span>

                    <div className="cart-line-text">
                      <p className="cart-line-name">{line.name}</p>
                      {line.note ? <p className="cart-line-note">{line.note}</p> : null}
                      {line.choiceLabel ? <p className="cart-line-note">{line.choiceLabel}</p> : null}
                      {/* Short here, because the name is already the line
                          above it. The named sentence is over the total, where
                          a basket of same-day items with one made-to-order one
                          among them needs to say which. */}
                      {leadDaysForProduct(menu, line.productId) ? (
                        <p className="cart-line-lead">
                          {t.cartLeadShort(leadDaysForProduct(menu, line.productId))}
                        </p>
                      ) : null}
                      {line.selections?.length ? (
                        <p className="cart-line-note">
                          {line.selections.map((pick) => `${pick.quantity}× ${pick.name}`).join(", ")}
                        </p>
                      ) : null}
                      <p className="cart-line-unit">
                        {t.price(line.price)} {t.cartEach}
                      </p>
                    </div>

                    {/* A group, not three loose buttons: it is one control for
                        one line, and the label is what tells a screen reader
                        which line the buttons belong to. */}
                    <div className="cart-qty" role="group" aria-label={line.name}>
                      <button
                        type="button"
                        className="cart-qty-btn btn"
                        aria-label={t.cartDecrease(line.name)}
                        onClick={() => setQty(lineKey(line), -1)}
                      >
                        <span aria-hidden="true">−</span>
                      </button>
                      {/* aria-live, because pressing + or − changes a number
                          the pressing finger is very likely covering. */}
                      <span className="cart-qty-value" aria-live="polite">
                        {line.qty}
                      </span>
                      <button
                        type="button"
                        className="cart-qty-btn btn"
                        aria-label={t.cartIncrease(line.name)}
                        onClick={() => setQty(lineKey(line), 1)}
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    </div>

                    <p className="cart-line-total">{t.price(line.price * line.qty)}</p>

                    <button
                      type="button"
                      className="cart-line-remove btn"
                      aria-label={t.cartRemove(line.name)}
                      onClick={() => remove(lineKey(line))}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>

              <footer className="cart-foot">
                {/* Named, and above the total rather than beside a line: this
                    is the sentence a customer has to have read before they pay,
                    and in a basket with one made-to-order item among five it is
                    the only place that says *which* one holds the order up. */}
                {leadLines.length > 0 && (
                  <div className="cart-lead" role="note">
                    {leadLines.map(({ key, name, days }) => (
                      <p key={key}>{t.cartLeadNote(name, days)}</p>
                    ))}
                  </div>
                )}

                <div className="cart-subtotal">
                  <span>{t.cartSubtotal}</span>
                  <strong>{t.price(subtotal)}</strong>
                </div>

                {closed && <p className="cart-closed" role="status">{t.ckClosed}</p>}
                <button type="button" className="cart-checkout btn" onClick={goToCheckout}>
                  {t.cartCheckout}
                </button>
                <p className="cart-handoff-note">{t.cartHandoffNote}</p>

                <button type="button" className="cart-clear btn" onClick={clear}>
                  {t.cartClear}
                </button>
              </footer>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
