import * as Dialog from "@radix-ui/react-dialog";
import { useCart } from "@/lib/cart";
import { useLang } from "@/lib/i18n";
import { Link, navigate } from "@/lib/router";

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
  const { t, lang } = useLang();

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
                  <li key={line.productId} className="cart-line">
                    <div className="cart-line-text">
                      <p className="cart-line-name">{line.name}</p>
                      {line.note ? <p className="cart-line-note">{line.note}</p> : null}
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
                        onClick={() => setQty(line.productId, -1)}
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
                        onClick={() => setQty(line.productId, 1)}
                      >
                        <span aria-hidden="true">+</span>
                      </button>
                    </div>

                    <p className="cart-line-total">{t.price(line.price * line.qty)}</p>

                    <button
                      type="button"
                      className="cart-line-remove btn"
                      aria-label={t.cartRemove(line.name)}
                      onClick={() => remove(line.productId)}
                    >
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>

              <footer className="cart-foot">
                <div className="cart-subtotal">
                  <span>{t.cartSubtotal}</span>
                  <strong>{t.price(subtotal)}</strong>
                </div>

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
