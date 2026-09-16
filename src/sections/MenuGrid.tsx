import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import AddToCart from "@/components/AddToCart";
import type { MenuSelection } from "@/components/MenuItemDetail";
import { GROUP_BY_CATEGORY_ID, type MenuCategory, type MenuItem } from "@/data/menu";
import { describeItem } from "@/data/menuCopy";
import { itemImage } from "@/data/menuImages";
import { localized, useLang } from "@/lib/i18n";
import { useLiveMenu, withLiveCatalogue } from "@/lib/liveMenu";
import { useCapability } from "@/lib/motion/useCapability";
import { Link } from "@/lib/router";
import { cx, useReveal } from "@/lib/reveal";
import { useOnceOpened } from "@/lib/useOnceOpened";

/**
 * The product section: a horizontal rail of photographs, built to the reference
 * screenshot's best-sellers row.
 *
 * The cards are the Cookie Pans as the dashboard left them — name, price, photo
 * and availability — and open the same dialog the menu page does. They were
 * three made-up products with their own prices, which the dashboard could not
 * change, whose "Order this" went to a placeholder WhatsApp number.
 */

/** The category the rail shows, and the section its link leads to. */
const RAIL_CATEGORY = "cookie-pans";

// The detail modal brings Framer Motion with it, and it is closed on load. All
// of that would otherwise sit in the bundle the hero has to wait for, to render
// a surface nobody has asked for yet. Fetched the first time a card is opened,
// and kept from then on — see useOnceOpened.
const MenuItemDetail = lazy(() => import("@/components/MenuItemDetail"));

interface RailState {
  /** The rail has somewhere to go at all. */
  scrollable: boolean;
  canPrev: boolean;
  canNext: boolean;
}

const AT_REST: RailState = { scrollable: false, canPrev: false, canNext: false };

/**
 * Whether the rail can move, and which way.
 *
 * Read from the rail itself rather than derived from the number of products,
 * because the answer depends on the viewport: three cards overflow a laptop and
 * fit a wide desktop. When they fit, both arrows are removed from the document
 * entirely — a visible control that does nothing when pressed is worse than no
 * control, and a disabled one still takes a tab stop to discover that.
 */
function useRailState(rail: RefObject<HTMLDivElement | null>): RailState {
  const [state, setState] = useState<RailState>(AT_REST);

  useEffect(() => {
    const node = rail.current;
    if (!node) return;

    let frame = 0;

    const read = () => {
      frame = 0;
      const max = node.scrollWidth - node.clientWidth;
      // A couple of pixels of slack. Sub-pixel layout means scrollLeft almost
      // never lands exactly on the maximum, and without this the forward arrow
      // stays lit at the end of the rail and does nothing when pressed.
      const slack = 2;
      // The absolute value is what makes this work in both directions. In a
      // right-to-left document a scroll container starts at scrollLeft 0 and
      // counts *down* to -(max) as it advances, so the raw comparisons below
      // would report an Arabic rail as permanently at its start — both arrows
      // wrong, in opposite ways. Distance travelled is the same number in
      // either direction, so measure that instead of a signed position.
      const travelled = Math.abs(node.scrollLeft);
      const next: RailState = {
        scrollable: max > slack,
        canPrev: travelled > slack,
        canNext: travelled < max - slack,
      };
      // Compared before setting. This runs on every frame of a scroll, and
      // handing React a fresh object each time re-renders the whole rail
      // sixty times a second to arrive at the same markup.
      setState((current) =>
        current.scrollable === next.scrollable
        && current.canPrev === next.canPrev
        && current.canNext === next.canNext
          ? current
          : next,
      );
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };

    read();
    node.addEventListener("scroll", schedule, { passive: true });
    // The rail's own box, not the window: the card width is a clamp on vw, so a
    // resize changes both how much there is to scroll and how much fits, and a
    // window listener would miss a change driven by anything else on the page.
    const observer = new ResizeObserver(schedule);
    observer.observe(node);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [rail]);

  return state;
}

function RailCard({
  item,
  category,
  index,
  onOpen,
}: {
  item: MenuItem;
  category: MenuCategory;
  index: number;
  /** Handed the button as well as the product, so focus can be returned to it. */
  onOpen: (item: MenuItem, category: MenuCategory, trigger: HTMLElement) => void;
}) {
  const [ref, anim] = useReveal<HTMLDivElement>(index);
  const { t, lang } = useLang();
  const name = localized(lang, item.name, item.nameAr);
  const note = item.note ? localized(lang, item.note, item.noteAr) : undefined;
  const photo = item.image ?? itemImage(item.id);
  const blurb = item.description
    ? localized(lang, item.description, item.descriptionAr)
    : describeItem(item, category);
  // A quick add only where one tap is a complete order; options and a choice
  // bundle are picked in the dialog.
  const quickAdd = !item.choices?.length && item.bundle?.type !== "choice";

  return (
    <div ref={ref} className={cx("rail-item", anim.className)} style={anim.style}>
      {/* A button rather than a div with an onClick. It is genuinely a control
          that opens a dialog, so it should be reachable by keyboard and
          announced as a button without any aria patching.

          These buttons are also what makes the rail keyboard-operable: tabbing
          to a card off the right edge scrolls it into view, so the rail needs no
          tabindex of its own and adds no empty tab stop. */}
      <button
        type="button"
        onClick={(event) => onOpen(item, category, event.currentTarget)}
        aria-haspopup="dialog"
        aria-label={t.menuDetailOpen(name)}
        className="pan-card group text-start w-full"
      >
        {/* Square, following the reference. `alt=""`: the name is right under
            the picture, and the button's own label already carries it. */}
        <div className="rail-photo">
          {photo ? (
            <img
              src={photo}
              alt=""
              className="pan-card-img"
              width={768}
              height={768}
              loading="lazy"
              decoding="async"
            />
          ) : null}
        </div>
        <h3 className="rail-name">{name}</h3>
        <p className="rail-price">
          {t.price(item.price)}
          {item.soldOut ? <> · {t.soldOut}</> : null}
        </p>
        <p className="rail-blurb">{blurb}</p>
      </button>

      {/* Outside the card button, not inside it. A `<button>` inside a
          `<button>` is invalid HTML, and browsers recover from it by dropping
          the inner one out of the outer — which produces markup that does not
          match the tree React thinks it rendered. Positioned over the card by
          the stylesheet instead, which also keeps it from being announced as
          part of the card's own label. */}
      {quickAdd && !item.soldOut ? (
        <AddToCart
          className="rail-add"
          label={t.addToCart}
          item={{
            productId: item.id,
            name,
            price: item.price,
            ...(note ? { note } : {}),
            ...(photo ? { image: photo } : {}),
          }}
        />
      ) : null}
    </div>
  );
}

export default function MenuGrid() {
  const { t } = useLang();
  const live = useLiveMenu();
  // Nothing until the catalogue answers: a rail of printed prices would be the
  // stale-data problem liveMenu.ts exists to prevent.
  const rail = useMemo(() => {
    const group = GROUP_BY_CATEGORY_ID.get(RAIL_CATEGORY);
    if (live.status !== "ready" || !group) return null;
    const category = withLiveCatalogue(group, live.menu).categories.find((entry) => entry.id === RAIL_CATEGORY);
    return category ? { category, items: category.items.filter((item) => !item.soldOut) } : null;
  }, [live]);
  const [active, setActive] = useState<MenuSelection | null>(null);
  const everOpened = useOnceOpened(active !== null);
  const [heading, headingAnim] = useReveal<HTMLDivElement>(0);
  const railRef = useRef<HTMLDivElement>(null);
  const { scrollable, canPrev, canNext } = useRailState(railRef);
  const { reduced } = useCapability();

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

  const open = useCallback((item: MenuItem, category: MenuCategory, element: HTMLElement) => {
    trigger.current = element;
    setActive({ item, category });
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

  const nudge = useCallback(
    (direction: 1 | -1) => {
      const node = railRef.current;
      if (!node) return;
      // One card plus its gap, measured off a real card rather than duplicating
      // the clamp from the stylesheet — the width is responsive, and a second
      // copy of that formula in JavaScript is a number that will go stale.
      const card = node.querySelector<HTMLElement>(".rail-item");
      const gap = parseFloat(getComputedStyle(node).columnGap) || 20;
      const step = (card?.offsetWidth ?? node.clientWidth * 0.8) + gap;
      // `scrollBy` takes a physical delta, so "forward" is a negative number in
      // a right-to-left document. Read from the element rather than from the
      // language, because this has to follow whatever direction the container
      // actually resolved to.
      const sign = getComputedStyle(node).direction === "rtl" ? -1 : 1;
      node.scrollBy({
        left: step * direction * sign,
        behavior: reduced ? "auto" : "smooth",
      });
    },
    [reduced],
  );

  return (
    <section className="bestsellers" id="menu">
      <div
        ref={heading}
        className={cx("bestsellers-head", headingAnim.className)}
        style={headingAnim.style}
      >
        <span className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-deep-burgundy mb-4 block">
          {t.bestTag}
        </span>
        <h2 className="font-display text-[40px] leading-[46px] lg:text-[72px] lg:leading-[80px] font-bold tracking-[-0.02em] text-primary mb-5">
          {t.bestTitle}
        </h2>
        <p className="font-body text-[16px] leading-[26px] text-on-surface-variant max-w-xl">
          {t.bestSub}
        </p>
        {/* The teaser's way out. The home page shows three products; the other
            ninety live on their own page rather than being rendered twice. */}
        <Link className="rail-cta btn" href="/menu">
          {t.bestCta}
          <span aria-hidden="true"> →</span>
        </Link>
      </div>

      <div className="rail-frame">
        <div className="rail" ref={railRef}>
          {rail?.items.map((item, index) => (
            <RailCard key={item.id} item={item} category={rail.category} index={index} onOpen={open} />
          ))}
        </div>

        {/* Rendered only when there is somewhere to go. */}
        {scrollable && (
          <>
            <button
              type="button"
              className="rail-arrow rail-arrow-prev"
              onClick={() => nudge(-1)}
              disabled={!canPrev}
              aria-label={t.railPrev}
            >
              <span aria-hidden="true">←</span>
            </button>
            <button
              type="button"
              className="rail-arrow rail-arrow-next"
              onClick={() => nudge(1)}
              disabled={!canNext}
              aria-label={t.railNext}
            >
              <span aria-hidden="true">→</span>
            </button>
          </>
        )}
      </div>

      {/* No Suspense fallback element. The modal animates in from nothing, and a
          spinner in its place would flash for one frame on a warm chunk. */}
      {everOpened && (
        <Suspense fallback={null}>
          <MenuItemDetail selection={active} onClose={close} />
        </Suspense>
      )}
    </section>
  );
}
