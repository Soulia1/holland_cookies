import { useAuth } from "@/lib/auth";
import { useLang } from "@/lib/i18n";
import { Link } from "@/lib/router";

/**
 * The account link in the header.
 *
 * Shows a filled mark once somebody is signed in, so the state is visible
 * without a name taking up room in a bar that has none. Rendered as a real
 * link to `/account`, which is where both the sign-in sheet and the signed-in
 * page live — so it is one destination whichever state you are in.
 */
export default function AccountButton({ className = "" }: { className?: string }) {
  const { customer, ready, accountsEnabled } = useAuth();
  const { t } = useLang();

  // No way to sign in without email, so no door to a sign-in form that cannot work.
  if (!accountsEnabled && !customer) return null;

  return (
    <Link
      href="/account"
      className={`cart-button btn ${className}`}
      aria-label={customer ? t.acTitle : t.acSignInTitle}
    >
      <span className="cart-button-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">
          <circle cx="12" cy="8.5" r="3.6" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M4.8 20c0-3.4 3.2-5.6 7.2-5.6s7.2 2.2 7.2 5.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {/* Only once the session has actually been read — a dot that appears and
          disappears on every load is worse than one that arrives a moment late. */}
      {ready && customer && <span className="account-dot" aria-hidden="true" />}
    </Link>
  );
}
