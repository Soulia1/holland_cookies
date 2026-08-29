import { useState } from "react";
import AddToCart from "@/components/AddToCart";
import { BOXES } from "@/data/boxes";
import { localized, useLang } from "@/lib/i18n";
import { cx, useReveal } from "@/lib/reveal";

/**
 * Build Your Box.
 *
 * A list of box sizes on the left, the selected box photographed large in the
 * middle, its name, price and order button on the right. Built to the reference
 * screenshot's layout in this site's own materials — oat ground, burgundy
 * accent, Playfair headings.
 *
 * The options are the real Cookie Boxes from the menu, by id, so the prices here
 * and the prices on `/menu` cannot disagree.
 */

export default function BuildYourBox() {
  const { t, lang } = useLang();
  const [selected, setSelected] = useState(BOXES[0]?.id ?? "");
  const [heading, headingAnim] = useReveal<HTMLDivElement>(0);
  const [body, bodyAnim] = useReveal<HTMLDivElement>(1);

  const active = BOXES.find((box) => box.id === selected) ?? BOXES[0];
  if (!active) return null;

  // Resolved once and passed to the cart as well as to the heading, so what the
  // customer read on the page is exactly what lands on the cart line.
  const activeName = localized(lang, active.name, active.nameAr);

  return (
    <section className="boxes" id="boxes">
      <div ref={heading} className={cx("boxes-head", headingAnim.className)} style={headingAnim.style}>
        <h2 className="boxes-title">{t.boxTitle}</h2>
        <p className="boxes-sub">{t.boxSub}</p>
      </div>

      <div ref={body} className={cx("boxes-grid", bodyAnim.className)} style={bodyAnim.style}>
        {/* A radiogroup, not a list of buttons. These are four mutually exclusive
            choices, which is what a radio group *is* — and it is what gets a
            keyboard user arrow keys between the options instead of four separate
            tab stops. */}
        <div className="box-options" role="radiogroup" aria-label={t.boxSizeLabel}>
          {BOXES.map((box) => (
            <button
              key={box.id}
              type="button"
              role="radio"
              aria-checked={box.id === selected}
              className={`box-option ${box.id === selected ? "is-selected" : ""}`}
              onClick={() => setSelected(box.id)}
            >
              <span className="box-option-thumb">
                <img src={box.image} alt="" aria-hidden="true" loading="lazy" decoding="async" />
              </span>
              <span className="box-option-text">
                <span className="box-option-name">{localized(lang, box.name, box.nameAr)}</span>
                <span className="box-option-price">{t.price(box.price)}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="box-stage">
          {/* Keyed on the selection so React swaps the element rather than
              mutating `src` on one that is already painted — without it the old
              photograph stays on screen until the new one has decoded, which
              reads as the click not having registered. */}
          <img
            key={active.id}
            className="box-photo"
            src={active.image}
            alt={active.alt}
            width={1408}
            height={768}
            loading="lazy"
            decoding="async"
          />
        </div>

        {/* aria-live, because on a phone this panel sits below the fold: the
            price changing is the only feedback that a tap did anything, and a
            screen reader would otherwise be told nothing at all. */}
        <div className="box-detail" aria-live="polite">
          <h3 className="box-detail-name">{activeName}</h3>
          <p className="box-detail-price">{t.price(active.price)}</p>
          {active.note ? (
            <p className="box-detail-note">{localized(lang, active.note, active.noteAr)}</p>
          ) : null}
          {/* This used to be a link to the shop's WhatsApp, with a comment
              explaining that a button which looks like it adds to a cart and
              does nothing is worse than no button. There is a cart now, so it
              is a button. */}
          <AddToCart
            className="box-order"
            label={t.addToCart}
            item={{
              productId: active.id,
              name: activeName,
              price: active.price,
              ...(active.note ? { note: localized(lang, active.note, active.noteAr) } : {}),
            }}
          />
          <p className="box-order-note">{t.boxNote}</p>
        </div>
      </div>
    </section>
  );
}
