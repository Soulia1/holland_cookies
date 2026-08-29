import { useCart } from "@/lib/cart";
import { useLang } from "@/lib/i18n";

/**
 * The header's cart button and its count.
 *
 * The badge is the site's only add-to-cart confirmation, which is why it is
 * animated: a number that changes silently in the corner of a header is not
 * feedback. `key={count}` restarts the bump on every change rather than only
 * on the first — without it, a second add plays no animation at all, because
 * the element and its running animation are both already there.
 *
 * There is deliberately no toast. Scooby uses Sonner for this; this project
 * declined it along with the rest of the library layer, and a badge that moves
 * plus the tick on the button that was just pressed say the same thing without
 * covering the thing the customer is looking at.
 */
export default function CartButton({ className = "" }: { className?: string }) {
  const { count, setOpen } = useCart();
  const { t } = useLang();

  return (
    <button
      type="button"
      className={`cart-button btn ${className}`}
      aria-label={t.cartOpen}
      onClick={() => setOpen(true)}
    >
      <span className="cart-button-icon" aria-hidden="true">
        {/* Drawn, not an icon font — the same trade the hamburger makes a few
            lines away in TopBar. */}
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
          <path
            d="M4 7h16l-1.3 11.2A2 2 0 0 1 16.7 20H7.3a2 2 0 0 1-2-1.8L4 7Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path
            d="M8.5 7V5.8a3.5 3.5 0 0 1 7 0V7"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {count > 0 && (
        <span key={count} className="cart-badge" aria-hidden="true">
          {count}
        </span>
      )}
    </button>
  );
}
