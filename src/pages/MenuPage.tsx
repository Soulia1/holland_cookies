import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import AddToCart from "@/components/AddToCart";
import { MENU } from "@/data/menu";
import { localized, useLang } from "@/lib/i18n";
import { useCapability } from "@/lib/motion/useCapability";
import { cx, useReveal } from "@/lib/reveal";

/**
 * The full menu.
 *
 * A long editorial page: one huge vertical MENU set into the left margin, a
 * sticky bar of the real categories, and every category as its own anchored
 * section. Interaction philosophy is taken from Scooby's menu — the active
 * category is resolved by one IntersectionObserver over the section headings
 * rather than by measuring on every scroll tick, and the mobile bar centres the
 * active pill by moving its own scrollLeft and nothing else. The look is this
 * site's: Playfair headings, burgundy accent, oat ground.
 */

/** The fixed site header's height. Matches HEADER_HEIGHT in TopBar.tsx. */
const HEADER_H = 88;
/** Air between the sticky bars and the heading they scroll a section under. */
const HEADING_GAP = 24;

function CategorySection({
  category,
  index,
  register,
}: {
  category: (typeof MENU)[number];
  index: number;
  register: (id: string, node: HTMLElement | null) => void;
}) {
  const [revealRef, anim] = useReveal<HTMLDivElement>(Math.min(index, 3));
  const { t, lang } = useLang();

  return (
    <section
      id={category.id}
      className="menu-section"
      aria-labelledby={`${category.id}-heading`}
      ref={(node) => register(category.id, node)}
    >
      <div ref={revealRef} className={cx(anim.className)} style={anim.style}>
        <h2 id={`${category.id}-heading`} className="menu-section-title">
          {localized(lang, category.name, category.nameAr)}
        </h2>
        {/* A list, because it is one. A screen reader announcing "list, seven
            items" before a category is the fastest possible summary of it. */}
        <ul className="menu-items">
          {category.items.map((item) => {
            // The name the customer is reading, resolved once and used for both
            // the row and the cart line it creates.
            const name = localized(lang, item.name, item.nameAr);
            const note = item.note ? localized(lang, item.note, item.noteAr) : undefined;

            return (
              <li key={item.id} className="menu-item">
                <span className="menu-item-name">
                  {name}
                  {note ? <span className="menu-item-note">{note}</span> : null}
                </span>
                {/* The dotted leader is a border on a spacer, so it stretches to
                    whatever gap is left between a name and its price and never
                    needs a character count. */}
                <span className="menu-item-leader" aria-hidden="true" />
                {/* The add control lives in the leader space, which is the one
                    part of this row that is empty by design. It is a price list
                    and not a card grid, so there is no card to lift and no image
                    to scale — the row simply warms and the control fades up
                    where the dots were. On touch it is always there; see
                    AddToCart. */}
                <AddToCart
                  className="menu-item-add"
                  item={{ productId: item.id, name, price: item.price, ...(note ? { note } : {}) }}
                />
                <span className="menu-item-price">{t.price(item.price)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

export default function MenuPage() {
  const { t, lang } = useLang();
  const { reduced } = useCapability();
  const navRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const sections = useRef(new Map<string, HTMLElement>());
  const [active, setActive] = useState<string>(MENU[0].id);
  /** The sticky category bar's own height, measured rather than assumed. */
  const [navH, setNavH] = useState(64);

  const register = useCallback((id: string, node: HTMLElement | null) => {
    if (node) sections.current.set(id, node);
    else sections.current.delete(id);
  }, []);

  // Measured, not hard-coded: the bar wraps to two rows at some widths and the
  // scroll offset below is wrong the moment the two disagree.
  useEffect(() => {
    const node = navRef.current;
    if (!node) return;
    const publish = () => {
      const height = node.offsetHeight;
      setNavH(height);
      // The stylesheet needs the same number for `scroll-margin-top`, which is
      // what makes the browser's own hash landing agree with ours.
      document.documentElement.style.setProperty("--menu-nav-h", `${height}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    publish();
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--menu-nav-h");
    };
  }, []);

  /**
   * Merge the two bars.
   *
   * At the top of the page the site header sits above the category bar, stacked.
   * Once the intro has gone by, the header slides up out of the way and the
   * category bar takes the top of the screen on its own — one bar, not two
   * stacked ones eating a third of a phone screen. Scrolling back up brings the
   * header back and the pair reassembles.
   *
   * The *intro* is what is observed, not a sentinel line. A zero-height marker
   * is the obvious implementation and is the one this project has already been
   * bitten by twice: an IntersectionObserver only fires on threshold crossings,
   * and a jump moves a marker from below the viewport to above it in one step
   * without ever intersecting. The intro is a few hundred pixels tall, so any
   * jump past it necessarily changes whether it intersects.
   */
  useEffect(() => {
    const intro = introRef.current;
    if (!intro) return;
    const root = document.documentElement;
    const observer = new IntersectionObserver(
      ([entry]) => {
        root.classList.toggle("is-menu-condensed", entry.boundingClientRect.bottom <= HEADER_H);
      },
      { rootMargin: `-${HEADER_H}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(intro);
    return () => {
      observer.disconnect();
      // Never left behind on the home page, where there is no category bar for
      // the hidden header to have merged with.
      root.classList.remove("is-menu-condensed");
    };
  }, []);

  /**
   * Where the page must land for a section heading to clear the bar.
   *
   * The site header is not in this sum. Scrolling to any section condenses the
   * page — the header slides away and the category bar takes the top — so by the
   * time the scroll lands there is only one bar to clear. Including the header
   * here would leave an 88px hole above every heading you jumped to.
   */
  const offsetFor = useCallback(
    (node: HTMLElement) =>
      node.getBoundingClientRect().top + window.scrollY - navH - HEADING_GAP,
    [navH],
  );

  /**
   * The active category follows the scroll: whichever heading most recently
   * passed under the sticky bar wins.
   *
   * One IntersectionObserver over the sections, adapted from Scooby. The naive
   * version runs on every scroll tick and calls getBoundingClientRect once per
   * category inside the handler — a forced synchronous layout per section, per
   * event, on the main thread, for an answer that changes a handful of times in
   * a whole page of scrolling. With seventeen categories that is seventeen
   * measurements a tick. The observer computes the same crossings off the main
   * thread and calls back only when one actually happens.
   */
  useEffect(() => {
    const line = navH + HEADING_GAP + 8;

    // Which sections currently reach below the bar. `isIntersecting` is state
    // the observer maintains, so it is always current; `entry.boundingClientRect`
    // is a snapshot from the moment a crossing was *recorded*, which is not the
    // same thing. Resolving from the rect is what made this lag by one category:
    // a smooth scroll finishes between crossings, and the last rect anyone saw
    // was measured mid-flight.
    const visible = new Set<string>();
    const order = MENU.map((category) => category.id);

    /**
     * The last category can never win on crossings alone.
     *
     * A section stops being the answer when it scrolls above the bar, and the
     * page hits its bottom stop before the last, shortest section can get there
     * — so standing at the bottom of the menu looking at Milkshakes, the bar
     * said Frappés. Answered here rather than by padding the page out with half
     * a screen of empty space to make the geometry work.
     */
    const atPageBottom = () =>
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }

        if (atPageBottom()) {
          setActive(order[order.length - 1]);
          return;
        }

        // The root is the viewport with everything above the bar trimmed off, so
        // the first section in document order that still reaches into it is
        // exactly the one being read. Everything earlier has gone by entirely.
        for (const id of order) {
          if (visible.has(id)) {
            setActive(id);
            return;
          }
        }
        // Nothing reaches below the bar — mid-flight between two sections on a
        // very short viewport. Leaving the previous answer standing is better
        // than guessing, and the next crossing corrects it a frame later.
      },
      { rootMargin: `-${line}px 0px 0px 0px`, threshold: 0 },
    );

    for (const node of sections.current.values()) observer.observe(node);

    /**
     * The bottom needs a scroll signal, because crossings stop happening there.
     *
     * The check above only runs when the observer fires, and the observer fires
     * on crossings — so arriving at the page's bottom stop mid-flight leaves the
     * last resolved answer standing. That is exactly the Milkshakes case: the
     * final crossing happened while the smooth scroll was still moving, and
     * nothing fired again once it stopped.
     *
     * One rAF-coalesced listener that does nothing but ask "are we at the
     * bottom". It reads `scrollHeight`, which during an ordinary scroll is a
     * cached value — nothing has dirtied layout — so this is not the
     * per-category `getBoundingClientRect` the observer exists to avoid.
     */
    let frame = 0;
    const checkBottom = () => {
      frame = 0;
      if (atPageBottom()) setActive(order[order.length - 1]);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(checkBottom);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // Rebuilt when the bar is re-measured: navH sets the root inset, and a
    // stale inset switches the pill at the wrong moment.
  }, [navH]);

  /**
   * Move the indicator to the active pill.
   *
   * `useLayoutEffect`, not `useEffect`: this reads the pill's box and writes the
   * indicator's, and doing that after paint shows one frame of the indicator in
   * its old place — a visible stutter on every category change.
   *
   * Measured against `offsetLeft` inside the scroller rather than
   * getBoundingClientRect against the viewport, so the value is independent of
   * how far the bar happens to be scrolled sideways and does not need
   * recomputing while the bar itself is moving.
   */
  useLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const pill = nav.querySelector<HTMLElement>(`[data-cat="${active}"]`);
    if (!pill) return;
    indicator.style.setProperty("--ind-x", `${pill.offsetLeft}px`);
    indicator.style.setProperty("--ind-w", `${pill.offsetWidth}px`);
    indicator.classList.add("is-ready");
    // Same reason as the centring effect below: switching language re-labels
    // every pill, so both the width and the offset it is measuring change.
  }, [active, navH, lang]);

  // Keep the active pill in view on mobile, where the bar scrolls sideways.
  //
  // Deliberately not scrollIntoView: that scrolls every scrollable ancestor,
  // the page included. The first category is active the moment the page loads,
  // so on arrival it would drag the viewport down to the bar. Only the bar's
  // own horizontal offset is touched here.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const pill = nav.querySelector<HTMLElement>(`[data-cat="${active}"]`);
    if (!pill) return;

    // Right-to-left scroll containers count backwards. `scrollLeft` is 0 at the
    // *start* — which in Arabic is the right-hand end — and runs down to
    // -(scrollWidth - clientWidth) at the far left. Two consequences, and the
    // original code was wrong about both:
    //
    //  1. The measurement below lands `max` short of the pill's real distance
    //     from the content's left edge, because the rect difference is a
    //     physical measurement while `scrollLeft` is a signed one.
    //  2. `Math.max(0, ...)` clamps every target to zero, since every valid
    //     RTL scroll position except the very start *is* negative. The bar
    //     simply never moved in Arabic, and the active pill stayed off screen.
    //
    // So the sum is normalised to one direction-free quantity — how much
    // content is hidden past the left edge, always 0…max — the centring is done
    // in that space, and the result is converted back at the end.
    const rtl = getComputedStyle(nav).direction === "rtl";
    const max = Math.max(0, nav.scrollWidth - nav.clientWidth);
    const hiddenLeft =
      pill.getBoundingClientRect().left
      - nav.getBoundingClientRect().left
      + nav.scrollLeft
      + (rtl ? max : 0);

    const centred = hiddenLeft - (nav.clientWidth - pill.offsetWidth) / 2;
    const clamped = Math.min(max, Math.max(0, centred));
    nav.scrollTo({
      left: rtl ? clamped - max : clamped,
      behavior: reduced ? "auto" : "smooth",
    });
    // `lang` is a dependency because the pills are re-labelled when it changes:
    // an Arabic label is a different width, so the position centred for the
    // English one is no longer centred.
  }, [active, reduced, lang]);

  const goTo = useCallback(
    (id: string) => {
      const node = sections.current.get(id);
      if (!node) return;
      setActive(id);
      // replaceState, not pushState: seventeen categories would otherwise put
      // seventeen entries in the history and turn Back into a tour of the page.
      window.history.replaceState(null, "", `#${id}`);
      window.scrollTo({ top: offsetFor(node), behavior: reduced ? "auto" : "smooth" });
    },
    [offsetFor, reduced],
  );

  // A `/menu#gateaux` link has to land in the right place. The browser's own
  // hash scrolling runs before React has rendered the sections and before the
  // bar has been measured, so it either does nothing or lands under the bars.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (!id) return;
    const node = sections.current.get(id);
    if (!node) return;
    // One frame, so the measurement above has published a real bar height.
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: offsetFor(node), behavior: "auto" });
      setActive(id);
    });
    return () => cancelAnimationFrame(frame);
    // Mount only: re-running this on every navH change would yank a reader who
    // has since scrolled somewhere else back to the anchor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="menu-page">
      {/* The decorative word. aria-hidden and pointer-events: none — it is
          scenery, and a screen reader announcing "MENU" between the header and
          the heading that already says Menu is a duplicate the sighted
          experience does not have. Sticky rather than fixed so it belongs to
          this page and scrolls away with the footer instead of hanging over it. */}
      <div className="menu-word-rail" aria-hidden="true">
        <span className="menu-word">{t.menuWord}</span>
      </div>

      <div className="menu-body" id="menu-content">
        <header className="menu-intro" ref={introRef}>
          <span className="menu-eyebrow">{t.menuEyebrow}</span>
          <h1 className="menu-title">{t.menuTitle}</h1>
        </header>

        <nav className="cat-nav" aria-label={t.menuCategoriesLabel}>
          <div className="cat-nav-scroll" ref={navRef}>
            {/* Decorative: the pills carry the state via aria-current, so this
                must not be announced as anything. */}
            <span className="cat-indicator" ref={indicatorRef} aria-hidden="true" />
            {MENU.map((category) => (
              <button
                key={category.id}
                type="button"
                data-cat={category.id}
                className={`cat-pill ${active === category.id ? "is-active" : ""}`}
                aria-current={active === category.id ? "true" : undefined}
                onClick={() => goTo(category.id)}
              >
                {localized(lang, category.name, category.nameAr)}
              </button>
            ))}
          </div>
        </nav>

        <div className="menu-sections">
          {MENU.map((category, index) => (
            <CategorySection
              key={category.id}
              category={category}
              index={index}
              register={register}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
