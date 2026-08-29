import { useCart } from "@/lib/cart";
import { useLang } from "@/lib/i18n";
import type { CartItem } from "@/lib/cart-core";

/**
 * The add-to-cart control.
 *
 * One component behind every "add" on the site, so the three surfaces that use
 * it — the menu rows, the best-seller cards, the box builder — cannot drift
 * apart in what they put into the cart or in what they say back.
 *
 * **Hover is the reveal, not the control.** On a pointer device the button is
 * faded and inert-looking until its row or card is hovered; on a touch device
 * it is simply always visible. That distinction is made in CSS by
 * `@media (hover: hover)` rather than here, and never by sniffing the user
 * agent — a touchscreen laptop has both, and the media query is the only thing
 * that answers "can this person actually hover" correctly. The button is a real
 * button in the document either way, so it is always focusable and always
 * reachable by a keyboard, whatever the pointer situation.
 */
export default function AddToCart({
  item,
  label,
  className = "",
}: {
  /** What goes into the cart. Its `name` is the *localized* display name. */
  item: Omit<CartItem, "qty">;
  /** The visible label. Cards show it; compact menu rows use an icon instead. */
  label?: string;
  className?: string;
}) {
  const { add, lastAdded } = useCart();
  const { t } = useLang();
  const justAdded = lastAdded === item.productId;

  return (
    <button
      type="button"
      className={`add-btn btn ${justAdded ? "is-added" : ""} ${className}`}
      // The accessible name always carries the product, even when the visible
      // label is a bare "Add to cart" or an icon. A screen reader user moving
      // down the menu would otherwise hear "add to cart" a hundred times with
      // nothing to tell them apart.
      aria-label={t.addToCartNamed(item.name)}
      onClick={(event) => {
        // The menu rows and the best-seller cards both sit inside larger
        // controls — a card is itself a button that opens the detail modal.
        // Without this, adding to the cart would also open the modal.
        event.stopPropagation();
        add(item);
      }}
    >
      <span className="add-btn-face" aria-hidden="true">
        {justAdded ? "✓" : "+"}
      </span>
      {label ? <span className="add-btn-label">{label}</span> : null}
      {/* The confirmation, announced rather than drawn. The visible feedback is
          the tick above and the cart badge counting up, which a screen reader
          user gets neither of. Kept mounted and emptied so the live region
          exists before the text lands in it — a region added to the document
          at the same moment as its content is not reliably announced. */}
      <span className="sr-only" role="status" aria-live="polite">
        {justAdded ? t.cartAdded(item.name) : ""}
      </span>
    </button>
  );
}
