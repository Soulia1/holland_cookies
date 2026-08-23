import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { PANS, type Pan } from "@/data/pans";
import { cx, useReveal } from "@/lib/reveal";
import { useOnceOpened } from "@/lib/useOnceOpened";

// The detail modal brings Framer Motion with it, and it is closed on load. All
// of that would otherwise sit in the bundle the hero has to wait for, to render
// a surface nobody has asked for yet. Fetched the first time a card is opened,
// and kept from then on — see useOnceOpened.
const PanDetail = lazy(() => import("@/components/PanDetail"));

function PanCard({
  pan,
  index,
  onOpen,
}: {
  pan: Pan;
  index: number;
  /** Handed the button as well as the product, so focus can be returned to it. */
  onOpen: (pan: Pan, trigger: HTMLElement) => void;
}) {
  const [ref, anim] = useReveal<HTMLDivElement>(index);

  return (
    <div ref={ref} className={cx("h-full", anim.className)} style={anim.style}>
      {/* A button rather than a div with an onClick. It is genuinely a control
          that opens a dialog, so it should be reachable by keyboard and
          announced as a button without any aria patching. */}
      <button
        type="button"
        onClick={(event) => onOpen(pan, event.currentTarget)}
        aria-haspopup="dialog"
        className="pan-card group text-left w-full h-full bg-surface-container-lowest rounded-lg overflow-hidden border border-surface-variant flex flex-col"
      >
        {/* 4:3, not square. The source is 1408x768, so a square crop keeps only
            768px of its width — under what a retina card needs — and magnifies
            the result. */}
        <div className="aspect-[4/3] bg-surface-container overflow-hidden">
          <img
            src={pan.image}
            alt={pan.alt}
            className="pan-card-img w-full h-full object-cover"
            width={1408}
            height={768}
            loading="lazy"
            decoding="async"
          />
        </div>
        <div className="p-6 md:p-8 flex flex-col flex-1">
          <div className="flex justify-between items-start gap-4 mb-3">
            <h3 className="font-display text-[24px] md:text-[28px] leading-[1.25] font-semibold text-primary">
              {pan.name}
            </h3>
            <span className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-deep-burgundy whitespace-nowrap mt-2">
              {pan.price} {pan.currency}
            </span>
          </div>
          <p className="font-body text-[16px] leading-[26px] text-on-surface-variant">
            {pan.blurb}
          </p>
          <span className="mt-5 font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary group-hover:text-deep-burgundy transition-colors duration-300">
            View details
          </span>
        </div>
      </button>
    </div>
  );
}

export default function MenuGrid() {
  const [active, setActive] = useState<Pan | null>(null);
  const everOpened = useOnceOpened(active !== null);
  const [heading, headingAnim] = useReveal<HTMLDivElement>(0);

  /**
   * The control that opened the dialog, so focus can be handed back to it.
   *
   * Radix returns focus on its own, but only when the dialog was opened through
   * its own `DialogTrigger`. These cards open it programmatically — the card is
   * a card first and a trigger second — so Radix has nothing to return to, and
   * closing the dialog dropped the keyboard user at the top of the document
   * with no idea where they had been. Restoring it here is the missing half.
   */
  const trigger = useRef<HTMLElement | null>(null);

  const open = useCallback((pan: Pan, element: HTMLElement) => {
    trigger.current = element;
    setActive(pan);
  }, []);

  const close = useCallback(() => setActive(null), []);

  // Restored after the close has committed, not during it: Radix moves focus as
  // part of its own unmount, and setting it first would simply be overwritten.
  useEffect(() => {
    if (active !== null) return;
    const element = trigger.current;
    if (!element) return;
    trigger.current = null;
    const frame = requestAnimationFrame(() => element.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <section className="bg-surface py-20 md:py-[80px] lg:py-[120px]" id="menu">
      <div className="max-w-[1440px] mx-auto px-5 md:px-12">
        <div ref={heading} className={cx("mb-12 md:mb-16", headingAnim.className)} style={headingAnim.style}>
          <span className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-deep-burgundy mb-4 block">
            The menu
          </span>
          <h2 className="font-display text-[40px] leading-[46px] lg:text-[72px] lg:leading-[80px] font-bold tracking-[-0.02em] text-primary mb-5">
            Signature pans
          </h2>
          <p className="font-body text-[16px] leading-[26px] text-on-surface-variant max-w-xl">
            Three bakes we make every single day. Pans serve two to four — or one,
            honestly.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
          {PANS.map((pan, index) => (
            <PanCard key={pan.id} pan={pan} index={index} onOpen={open} />
          ))}
        </div>
      </div>

      {/* No Suspense fallback element. The modal animates in from nothing, and a
          spinner in its place would flash for one frame on a warm chunk. */}
      {everOpened && (
        <Suspense fallback={null}>
          <PanDetail pan={active} onClose={close} />
        </Suspense>
      )}
    </section>
  );
}
