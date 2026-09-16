import { useEffect, useRef, useState } from "react";
import { useCapability } from "@/lib/motion/useCapability";
import { localized, useLang } from "@/lib/i18n";
import { Link } from "@/lib/router";
import type { Order } from "@/lib/api";
import { parseStamp, SHOP_TIME_ZONE } from "@/lib/dates";

/**
 * The order confirmation, printed.
 *
 * A card that behaves like a receipt printer: the paper feeds out of a slot
 * along its bottom edge, and once it has finished the status line flips from
 * "Printing your receipt" to "Order complete".
 *
 * The mechanic, read frame by frame off the reference recording: the paper
 * starts at `translateY(-100%)` inside a clipping box whose top edge is the
 * slot, and animates to `translateY(0)`. That is what makes the *bottom* of the
 * receipt — the barcode and the torn edge — emerge first, with the earlier
 * lines appearing from under the card as it feeds. Animating it the other way
 * round reads as a panel sliding down rather than as paper being printed.
 *
 * **The feed is stepped, not smooth.** Differencing consecutive frames of the
 * recording shows the change magnitude swinging by an order of magnitude with
 * near-still frames in between — the paper advances, pauses, advances. That is
 * what a thermal printer does: it drives the platen one text line at a time,
 * and the judder is most of what makes it read as printing rather than sliding.
 * So the timing function is `steps()`, with one step per line of the receipt —
 * measured below rather than guessed, so a long order and a short one both
 * advance at the same physical rate instead of the same total duration.
 *
 * Still one transform on one element, so the whole feed runs on the compositor.
 */

/**
 * How fast the platen advances, in lines per second.
 *
 * Taken from the recording: the still frames fall roughly every third frame of
 * 30fps video, so the paper moves about ten times a second. Driving the feed
 * from a *rate* rather than a fixed duration is what keeps a two-line order and
 * a twenty-line one advancing at the same believable speed — a fixed duration
 * would make a long receipt fly out.
 */
const LINES_PER_SECOND = 11;

/** Bounds on the total, so a huge order does not print for half a minute. */
const MIN_FEED_MS = 900;
const MAX_FEED_MS = 3200;

/** The shop's line, as it is printed on a real receipt. Also in Footer.tsx. */
const SHOP_PHONE = "+20 101 652 1650";

/**
 * Deterministic bars for the barcode.
 *
 * Derived from the reference so the same order always prints the same code —
 * a barcode that reshuffled on every render would be obviously fake. It does
 * not encode anything scannable and does not pretend to: it is the texture at
 * the bottom of a receipt, and the human-readable reference is printed under it.
 */
function bars(reference: string): number[] {
  let seed = 0;
  for (let i = 0; i < reference.length; i += 1) {
    seed = (seed * 31 + reference.charCodeAt(i)) >>> 0;
  }
  return Array.from({ length: 44 }, () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return 1 + ((seed >>> 16) % 3);
  });
}

export default function ReceiptPrinter({ order }: { order: Order }) {
  const { t, lang } = useLang();
  const { reduced } = useCapability();
  const [printed, setPrinted] = useState(reduced);
  const paperRef = useRef<HTMLDivElement>(null);

  // The status flips when the paper has actually finished feeding, not on a
  // guess: a timer that disagrees with the animation would say "complete" over
  // a receipt still visibly moving.
  useEffect(() => {
    if (reduced) return;
    const node = paperRef.current;
    const sheet = node?.firstElementChild as HTMLElement | null;
    if (!node || !sheet) return;

    // One step per printed line, measured off the rendered sheet rather than
    // assumed — the receipt's height depends on how many things were ordered.
    // `lineHeight` can compute to "normal" on a font that has not settled yet,
    // in which case fall back to the ratio the stylesheet sets.
    const lineHeight = parseFloat(getComputedStyle(sheet).lineHeight);
    const perLine = Number.isFinite(lineHeight) && lineHeight > 4 ? lineHeight : 20;
    const steps = Math.max(6, Math.round(sheet.offsetHeight / perLine));
    const duration = Math.min(
      MAX_FEED_MS,
      Math.max(MIN_FEED_MS, (steps / LINES_PER_SECOND) * 1000),
    );

    node.style.animationDuration = `${duration}ms`;
    // Set from here rather than in the stylesheet because the count is only
    // known once the sheet has been laid out.
    node.style.animationTimingFunction = `steps(${steps}, end)`;

    const done = () => setPrinted(true);
    node.addEventListener("animationend", done, { once: true });
    // Belt and braces — if the animation never runs (a browser that refused it,
    // a tab backgrounded through the whole thing) the status must not stay on
    // "printing" for ever.
    const failsafe = window.setTimeout(done, duration + 800);
    return () => {
      node.removeEventListener("animationend", done);
      window.clearTimeout(failsafe);
    };
  }, [reduced]);

  const delivering = order.fulfilment === "delivery";
  const customerName = [order.customer.firstName, order.customer.lastName].filter(Boolean).join(" ");
  // The address as the customer typed it. The area is stored as an id and the
  // receipt has no settings to name it from; the tracking page names it.
  const deliverTo = [order.delivery.address, order.delivery.building, order.delivery.floor, order.delivery.apartment]
    .filter(Boolean).join(", ");

  const placed = parseStamp(order.createdAt).toLocaleString(
    lang === "ar" ? "ar-EG" : "en-GB",
    { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: SHOP_TIME_ZONE },
  );

  return (
    <main className="rcpt-page">
      <div className="rcpt-stage">
        {/* — The printer ————————————————————————————————— */}
        <div className="rcpt-card">
          <div className="rcpt-card-top">
            <span className="rcpt-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                <path d="M12 3.2 14.4 9l5.8.5-4.4 3.9 1.3 5.7L12 16l-5.1 3.1 1.3-5.7L3.8 9.5 9.6 9Z"
                  stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </span>
            <Link className="rcpt-home" href="/menu">
              <span aria-hidden="true">⌂</span> {t.okContinue}
            </Link>
          </div>

          <div className="rcpt-panel">
            <div className="rcpt-panel-row">
              <div>
                <p className="rcpt-plan">{t.okTitle}</p>
                <p className="rcpt-plan-sub">{t.okThanks(order.customer.firstName)}</p>
              </div>
              <div className="rcpt-total-block">
                <p className="rcpt-total-label">{t.ckTotal}</p>
                <p className="rcpt-total-value">{t.price(order.totals.total)}</p>
              </div>
            </div>

            {/* aria-live, because this is the only thing on screen that says
                the order actually went through. */}
            <p className="rcpt-status" aria-live="polite">
              <span className={`rcpt-status-dot ${printed ? "is-done" : ""}`} aria-hidden="true" />
              {printed ? t.rpComplete : t.rpPrinting}
            </p>
          </div>

        </div>

        {/* — The paper ——————————————————————————————————— */}
        <div className="rcpt-feed">
          {/* The slot, painted on top of the paper rather than inside the card.
              Inside the card it sat *behind* the sheet, so the card's own
              background covered the opening and the paper could only ever
              appear below the whole bar — never through it. Here the paper's
              leading edge slides up under this and disappears into the gap. */}
          <span className="rcpt-mouth" aria-hidden="true" />
          <div
            ref={paperRef}
            className={`rcpt-paper ${reduced ? "is-instant" : ""}`}
          >
            {/* The sheet is a separate element from the animated one so the
                torn edge can be a mask on it while the drop shadow lives on the
                parent. A mask clips its own element's shadow, so putting both
                on one element loses the shadow entirely. */}
            <div className="rcpt-sheet">
            <p className="rcpt-brand">HOLLAND COOKIES</p>
            <p className="rcpt-brand-sub" dir="ltr">{SHOP_PHONE}</p>

            <div className="rcpt-rule" aria-hidden="true" />

            <ul className="rcpt-lines">
              {order.items.map((item, index) => (
                // Indexed: the same product with two different options is two lines.
                <li key={`${item.productId}-${index}`}>
                  <span>
                    {item.qty} × {localized(lang, item.name, item.nameAr)}
                    {item.choice ? ` — ${localized(lang, item.choice.name, item.choice.nameAr)}` : ""}
                  </span>
                  <span>{item.lineTotal.toFixed(2)}</span>
                </li>
              ))}
            </ul>

            <div className="rcpt-rule" aria-hidden="true" />

            <ul className="rcpt-lines">
              <li><span>{t.cartSubtotal}</span><span>{order.totals.subtotal.toFixed(2)}</span></li>
              {order.totals.discount > 0 && (
                <li>
                  <span>{order.promoCode ? `${t.ckPromo} (${order.promoCode})` : t.ckPromo}</span>
                  <span>−{order.totals.discount.toFixed(2)}</span>
                </li>
              )}
              <li><span>{t.ckDelivery}</span><span>{order.totals.delivery.toFixed(2)}</span></li>
            </ul>

            <p className="rcpt-paid">
              <span>{t.rpTotalPaid}</span>
              <span>{t.price(order.totals.total)}</span>
            </p>

            <ul className="rcpt-meta">
              <li><span>{t.rpOrder}</span><span dir="ltr">{order.reference}</span></li>
              <li><span>{t.rpName}</span><span>{customerName}</span></li>
              <li><span>{t.ckPhone}</span><span dir="ltr">{order.customer.phone}</span></li>
              {delivering && deliverTo ? (
                <li><span>{t.rpDeliverTo}</span><span>{deliverTo}</span></li>
              ) : null}
              <li>
                <span>{t.rpPaidWith}</span>
                {/* Matches the method the checkout actually offered for
                    this order's fulfilment type. */}
                <span>{delivering ? t.ckPayCash : t.ckPayPickup}</span>
              </li>
              <li><span>{t.rpDate}</span><span dir="ltr">{placed}</span></li>
            </ul>

            <div className="rcpt-barcode" aria-hidden="true">
              {bars(order.reference).map((weight, index) => (
                <i key={index} style={{ width: `${weight}px` }} />
              ))}
            </div>
            <p className="rcpt-barcode-text" dir="ltr">{order.reference}</p>
            </div>
          </div>
        </div>

        <div className={`rcpt-actions ${printed ? "is-in" : ""}`}>
          <Link className="ed-btn" href={`/track?ref=${encodeURIComponent(order.reference)}`}>
            {t.okTrack}
          </Link>
          <Link className="ed-ghost" href="/menu">{t.okContinue}</Link>
        </div>
      </div>
    </main>
  );
}
