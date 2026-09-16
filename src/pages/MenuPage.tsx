import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AddToCart from "@/components/AddToCart";
import type { MenuSelection } from "@/components/MenuItemDetail";
import { MENU_GROUPS, priceFrom, type MenuCategory, type MenuGroup } from "@/data/menu";
import { itemImage } from "@/data/menuImages";
import type { MenuItem } from "@/data/menu";
import { useOnceOpened } from "@/lib/useOnceOpened";
import { useLiveMenu, withLiveCatalogue } from "@/lib/liveMenu";
import { localized, useLang } from "@/lib/i18n";
import { Link } from "@/lib/router";
import { cx, useReveal } from "@/lib/reveal";

/**
 * One group of the menu, as its own page.
 *
 * This page has been through two shapes before this one and both are worth
 * knowing, because this is the synthesis of them rather than a third idea.
 *
 * It began as the *whole* menu on one route: seventeen anchored sections, a
 * scrollspy resolving which one you were reading, six thousand pixels of page.
 * Then it became a page per category — `/menu/cookie-pans` — which deleted the
 * scrollspy and made the active category the URL instead of a guess made from
 * scroll geometry. What that traded away only showed up in the bar: seventeen
 * pills, seven of which begin with the word "Cookie", scrolling sideways on a
 * phone. Finding the coffee meant swiping past six kinds of cookie, and two
 * kinds of cookie that a customer would compare — a Cookie Cup against a Cookie
 * Scoop — could not be seen at the same time at all.
 *
 * So the categories are grouped. The bar carries three groups; the page carries
 * that group's categories as sections, one under the next, with a second bar of
 * section chips under the first. Both halves of the history are kept:
 *
 *  - From the page-per-category version: the *group* is the URL, not a guess.
 *    Which of the three pages you are on is never inferred from scroll.
 *  - From the one-page version: a scrollspy, because within a page the section
 *    you are reading genuinely is a fact about scroll position and there is
 *    nothing else it could be read from.
 *
 * The scrollspy is a scroll listener rather than an IntersectionObserver, which
 * is a deliberate reversal of the original. An observer reports where its
 * targets are when it *delivers*, not every position they passed through, so a
 * jump — an anchor click, exactly what the chips below do — can move a section
 * from below the viewport to above it without crossing a threshold in any
 * delivery. This project has been bitten by that three times now (see the reveal
 * helper and the condense observer below, which survives it only because it
 * watches something hundreds of pixels tall). A listener reading positions each
 * frame cannot miss a state, because it does not depend on transitions at all.
 */

/** The fixed site header's height before it can be measured. Matches HEADER_HEIGHT in TopBar.tsx. */
const HEADER_H = 88;

// The dialog brings Radix and Framer Motion with it and is closed on load, so
// it is fetched the first time a row is opened and kept from then on. Same
// treatment the home page gives PanDetail, for the same reason.
const MenuItemDetail = lazy(() => import("@/components/MenuItemDetail"));

/** Where each group sits in the bar, so prev/next is a lookup and not a scan. */
const ORDER = new Map(MENU_GROUPS.map((group, index) => [group.id, index]));

export default function MenuPage({
  group,
  section,
}: {
  group: MenuGroup;
  /**
   * A category id inside `group` that the URL named, if any.
   *
   * Resolved by the router, not here, because it is a fact about the address
   * rather than about this component — and because deciding it here would mean
   * reading `window.location` during render, which is the one thing that makes
   * a page render differently on two calls with the same props.
   */
  section: string | null;
}) {
  const { t, lang } = useLang();
  const live = useLiveMenu();
  // No sections until the database answers: the printed products are never
  // shown in its place (see liveMenu.ts).
  const shown = useMemo(
    () => (live.status === "ready" ? withLiveCatalogue(group, live.menu) : { ...group, categories: [] }),
    [group, live],
  );
  const ready = live.status === "ready";
  const barRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const subNavRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  const active = group.id;
  const index = ORDER.get(active) ?? 0;
  const previous = index > 0 ? MENU_GROUPS[index - 1] : null;
  const next = index < MENU_GROUPS.length - 1 ? MENU_GROUPS[index + 1] : null;

  const name = localized(lang, group.name, group.nameAr);

  /**
   * Which section the reader is in.
   *
   * Seeded from the URL rather than from the first category, so a `#cookie-pans`
   * arrival has the right chip lit on the first frame instead of lighting the
   * first chip and correcting itself once the scroll lands.
   */
  const [reading, setReading] = useState<string>(section ?? shown.categories[0]?.id ?? "");

  /**
   * The row whose dialog is open, and the control that opened it.
   *
   * The trigger is kept for the same reason MenuGrid keeps one: these rows open
   * the dialog programmatically rather than through Radix's own DialogTrigger,
   * so Radix has nothing to hand focus back to on close and a keyboard user
   * would be dropped at the top of the document with no idea where they had
   * been.
   */
  const [selection, setSelection] = useState<MenuSelection | null>(null);
  const everOpened = useOnceOpened(selection !== null);
  const trigger = useRef<HTMLElement | null>(null);

  const openItem = useCallback((item: MenuItem, category: MenuCategory, element: HTMLElement) => {
    trigger.current = element;
    setSelection({ item, category });
  }, []);

  const closeItem = useCallback(() => setSelection(null), []);

  // Restored after the close has committed, not during it: Radix moves focus as
  // part of its own unmount, and setting it first is simply overwritten.
  useEffect(() => {
    if (selection !== null) return;
    const element = trigger.current;
    if (!element) return;
    trigger.current = null;
    const frame = requestAnimationFrame(() => element.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [selection]);

  /**
   * Everything the bar has to be told, in one pass: its own height, where the
   * group indicator goes, and how far each of the two rows has to scroll
   * sideways for its active control to be on screen.
   *
   * One function rather than several effects, because they all read the same
   * boxes and all go stale for the same reasons — and one of those reasons was
   * a real bug. Splitting the category page out of the one-page menu removed a
   * piece of measured `navH` state that had quietly been doubling as the
   * trigger that re-measured the indicator. Without it the first measurement
   * was the only measurement: on the Arabic page the pills lay out in the
   * fallback font, Cairo arrives a moment later and every label narrows, and
   * the indicator sat 25px to the side of the pill it was meant to be under for
   * the life of the page.
   *
   * So it is re-run from three places below: a layout effect, a ResizeObserver,
   * and `document.fonts.ready`.
   */
  const sync = useCallback(() => {
    const bar = barRef.current;
    const nav = navRef.current;
    if (!bar || !nav) return;

    // Measured, not hard-coded, and measured on the whole sticky bar rather
    // than on either row: the rows can wrap, and the stylesheet's own offsets
    // are wrong the moment a literal and the real height disagree. This is what
    // `.menu-section`'s scroll-margin is built from, so a section heading
    // landing under the bar is exactly this number being wrong.
    document.documentElement.style.setProperty("--menu-nav-h", `${bar.offsetHeight}px`);

    const pill = nav.querySelector<HTMLElement>(`[data-cat="${active}"]`);
    if (!pill) return;

    // Measured against `offsetLeft` inside the scroller rather than
    // getBoundingClientRect against the viewport, so the value is independent
    // of how far the bar happens to be scrolled sideways and does not need
    // recomputing while the bar itself is moving.
    const indicator = indicatorRef.current;
    if (indicator) {
      indicator.style.setProperty("--ind-x", `${pill.offsetLeft}px`);
      indicator.style.setProperty("--ind-w", `${pill.offsetWidth}px`);
      indicator.classList.add("is-ready");
    }

    // `auto`, never smooth, and that is a change from the one-page menu. There
    // the bar moved while the reader watched it, so the slide explained itself.
    // Here the page underneath has just been replaced, and a bar that arrives
    // already scrolled to the right pill reads as the new page's own state
    // rather than as something reacting after the fact.
    centre(nav, pill, "auto");
  }, [active]);

  /**
   * Keep the active *chip* in view, which on a phone is most of what the second
   * row does — there are seven of them under Cookies and perhaps three fit.
   *
   * Split from `sync` because it fires for a different reason: `sync` runs when
   * the page or the fonts change, this runs every time the reader scrolls past
   * a heading. Smooth here, unlike the row above: the reader is looking at the
   * page while it happens, so a chip that slides into place is the bar
   * following them rather than a jump they did not ask for.
   */
  useEffect(() => {
    const scroller = subNavRef.current;
    if (!scroller) return;
    const chip = scroller.querySelector<HTMLElement>(`[data-sub="${reading}"]`);
    if (chip) centre(scroller, chip, "smooth");
  }, [reading, lang]);

  /**
   * `useLayoutEffect`, not `useEffect`: this reads the pill's box and writes the
   * indicator's, and doing that after paint shows one frame of the indicator in
   * its old place — a visible stutter on every group change.
   *
   * `lang` is a dependency because switching language re-labels every pill, so
   * both the width being measured and the offset it sits at change.
   */
  useLayoutEffect(sync, [sync, lang]);

  useEffect(() => {
    const node = barRef.current;
    if (!node) return;
    const observer = new ResizeObserver(sync);
    observer.observe(node);

    // The bar can be re-laid-out without its own box ever changing: a webfont
    // swap moves every pill sideways while the bar they sit in keeps exactly
    // the same width and height, so the observer above never fires for the one
    // case that actually broke this. `fonts.ready` is that case.
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live) sync();
    });

    return () => {
      live = false;
      observer.disconnect();
      document.documentElement.style.removeProperty("--menu-nav-h");
    };
  }, [sync]);

  /**
   * The scrollspy.
   *
   * The line it measures against is the sticky bar's own bottom edge, read
   * fresh each time rather than computed from `HEADER_H` plus a nav height.
   * That edge moves — the site header slides up out of it a few hundred pixels
   * down the page — and a spy using a fixed offset is off by the header's
   * height for the whole first screen, which is precisely the stretch where the
   * first two sections are being read.
   *
   * A section is "being read" once its top has gone under that line, so the
   * answer is the last one that has. The bottom-of-page case is separate and is
   * not an optimisation: the final section is usually shorter than a viewport,
   * so its top may never reach the line at all and it could otherwise never
   * become active however far down the reader goes.
   */
  const ids = shown.categories.map((category) => category.id).join(" ");
  useEffect(() => {
    const list = ids.split(" ");
    let frame = 0;

    const measure = () => {
      frame = 0;
      const bar = barRef.current;
      if (!bar) return;
      const line = bar.getBoundingClientRect().bottom + 4;

      let found = list[0];
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) found = id;
      }

      const doc = document.documentElement;
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) found = list[list.length - 1];

      setReading((current) => (current === found ? current : found));
    };

    // Coalesced to one measurement per frame. A scroll event can fire many
    // times between paints, and every one of these reads layout.
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [ids]);

  /**
   * Land on the section the URL named.
   *
   * Only on arrival, and only for a hash that came in with the page — the chips
   * below route through `navigate`, which does its own scrolling, and the spy
   * above never writes the URL. So this runs when the *page* changes and not
   * when the reading position does.
   *
   * `scroll-behavior` is forced to `auto` around the jump. The stylesheet sets
   * `smooth` globally, which is right for a click on a chip and wrong here: a
   * deep link would otherwise open at the top of the page and then travel down
   * through several thousand pixels of menu the reader did not ask to see.
   *
   * And it lands more than once, which is not belt and braces — a single
   * landing is measurably wrong, and both reasons are worth writing down
   * because neither is visible from the code that does the scrolling.
   *
   *  1. **The stylesheet is not applied yet.** A module script is deferred, so
   *     it runs once the document has been *parsed*; a stylesheet only blocks
   *     rendering, not that. So the first thing this component does on a cold
   *     load happens against an unstyled page. Measured on the built site with
   *     `scrollIntoView` instrumented: at the moment of the jump the sticky bar
   *     was 36px tall rather than 115, `scroll-padding-top` was `auto` and the
   *     section's `scroll-margin-top` was `0px` — none of the arithmetic the
   *     stylesheet does existed. The page then restyled underneath the scroll
   *     and `/menu/cookie-pans` came to rest with its heading 55px *behind* the
   *     bar, which is the one place a heading must never be.
   *  2. **The webfonts land later still**, and every heading above the target
   *     changes height when they do. The same hazard the indicator above
   *     re-measures for, for the same reason.
   *
   * So: land now, land again on `load` (which does wait for stylesheets), and
   * land again after `fonts.ready`. All three are the same call; the page is
   * simply asked where the section is at three moments when the answer differs.
   *
   * Any real input from the reader ends it. From the first wheel, touch, key or
   * pointer the scroll position is theirs, and a correction that arrives after
   * someone has started reading is not a correction — it is the page taking the
   * page away from them. Deliberately not a scroll-position check: the restyle
   * in (1) moves the page on its own, so "has it moved?" cannot tell the
   * difference between the bug and the reader.
   */
  useEffect(() => {
    if (!section) return;
    const target = document.getElementById(section);
    if (!target) return;

    let live = true;
    const surrender = () => {
      live = false;
    };
    const gestures = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const gesture of gestures) {
      window.addEventListener(gesture, surrender, { passive: true });
    }

    const land = () => {
      if (!live) return;
      const root = document.documentElement;
      const previousBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      target.scrollIntoView();
      root.style.scrollBehavior = previousBehavior;
    };

    land();
    if (document.readyState !== "complete") window.addEventListener("load", land);
    // A frame after, so the reflow the new fonts cause has been laid out and
    // not merely scheduled.
    void document.fonts?.ready.then(() => requestAnimationFrame(land));

    return () => {
      live = false;
      window.removeEventListener("load", land);
      for (const gesture of gestures) window.removeEventListener(gesture, surrender);
    };
    // `group.id` is in here so that arriving at a *different* group at the same
    // section id — impossible today, but a regrouping away — still lands.
    // `ready` because the sections only exist once the catalogue has arrived.
  }, [section, group.id, ready]);

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
    // The header's real height: 88px is its phone size, and on a desktop it is
    // 112px, which left the category bar under it for the last 24px of travel.
    const header = document.querySelector<HTMLElement>(".site-header");
    const apply = (bottom: number) =>
      root.classList.toggle("is-menu-condensed", bottom <= (header?.offsetHeight || HEADER_H));
    const observer = new IntersectionObserver(
      ([entry]) => apply(entry.boundingClientRect.bottom),
      { rootMargin: `-${HEADER_H}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(intro);

    // The observer alone left the header hidden for good on phones: a jump
    // straight back to the top of a long page could arrive without its
    // callback, and the header — with the cart button in it — stayed
    // translated off-screen at scrollY 0. A scroll check, at most once a frame,
    // settles the same question from the intro's actual position whenever the
    // page moves, so the header always comes back.
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply(intro.getBoundingClientRect().bottom);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      // Never left behind on a page that has no category bar for the hidden
      // header to have merged with.
      root.classList.remove("is-menu-condensed");
    };
  }, []);

  return (
    <main className="menu-page">
      {/* The decorative word. aria-hidden and pointer-events: none — it is
          scenery, and a screen reader announcing "MENU" between the header and
          the heading is a duplicate the sighted experience does not have.
          Sticky rather than fixed so it belongs to this page and scrolls away
          with the footer instead of hanging over it. */}
      <div className="menu-word-rail" aria-hidden="true">
        <span className="menu-word">{t.menuWord}</span>
      </div>

      <div className="menu-body" id="menu-content">
        {/* The group is the page, so its name is the page's h1. The sections
            below carry h2s, which is the whole reason the grouping is worth
            doing to a screen reader as well: one heading level to skim by. */}
        <header className="menu-intro" ref={introRef}>
          <span className="menu-eyebrow">{t.menuTitle}</span>
          <h1 className="menu-title">{name}</h1>
        </header>

        {/* One sticky element holding both rows, rather than two stickies at two
            offsets. They travel together, they are measured together, and
            `--menu-nav-h` is one number instead of a sum that any change to
            either row can put out of step. */}
        <div className="cat-nav" ref={barRef}>
          <nav className="cat-nav-row" aria-label={t.menuCategoriesLabel}>
            <div className="cat-nav-scroll" ref={navRef}>
              {/* Decorative: the pills carry the state via aria-current, so this
                  must not be announced as anything. */}
              <span className="cat-indicator" ref={indicatorRef} aria-hidden="true" />
              {MENU_GROUPS.map((entry) => (
                <Link
                  key={entry.id}
                  href={`/menu/${entry.id}`}
                  data-cat={entry.id}
                  className={`cat-pill ${active === entry.id ? "is-active" : ""}`}
                  // "page", not "true". These are links to pages, and the page
                  // one of them leads to is the one being read.
                  aria-current={active === entry.id ? "page" : undefined}
                >
                  {localized(lang, entry.name, entry.nameAr)}
                </Link>
              ))}
            </div>
          </nav>

          {/* The second row. Deliberately a different shape from the first — no
              travelling indicator, no filled pill — because these two rows are
              not peers: one changes the page, the other moves within it. Two
              identical-looking bars stacked would read as one control that had
              been split in half. */}
          <nav className="subcat-nav" aria-label={t.menuSectionsLabel(name)}>
            <div className="subcat-scroll" ref={subNavRef}>
              {shown.categories.map((category) => (
                <Link
                  key={category.id}
                  // A full address, not a bare `#id`. It is the same page, so
                  // the router treats it as a hash change and scrolls, but what
                  // the status bar shows and what a copied link contains is the
                  // canonical address of that section.
                  href={`/menu/${group.id}#${category.id}`}
                  data-sub={category.id}
                  className={`subcat-chip ${reading === category.id ? "is-reading" : ""}`}
                  // "location", not "page": this names a place within the page
                  // being read, which is exactly the distinction that value is
                  // for. The pills above are the ones that say "page".
                  aria-current={reading === category.id ? "location" : undefined}
                >
                  {localized(lang, category.name, category.nameAr)}
                </Link>
              ))}
            </div>
          </nav>
        </div>

        <div className="menu-sections">
          {live.status === "loading" && (
            <p className="menu-status" role="status">{t.menuLoading}</p>
          )}
          {live.status === "error" && (
            <div className="menu-status" role="alert">
              <p>{t.menuLoadFailed}</p>
              <button type="button" className="menu-status-retry" onClick={live.retry}>
                {t.menuRetry}
              </button>
            </div>
          )}
          {shown.categories.map((category) => (
            <Section key={category.id} category={category} onOpen={openItem} />
          ))}

          {/* The way on, for a reader who has finished this group and is at the
              bottom of the page with the bar off screen above them. */}
          <nav className="menu-pager" aria-label={t.menuPagerLabel}>
            {previous ? (
              <Link className="menu-pager-link is-prev" href={`/menu/${previous.id}`} rel="prev">
                <span className="menu-pager-dir">
                  <span className="menu-pager-arrow" aria-hidden="true">
                    ←
                  </span>
                  {t.menuPrevCategory}
                </span>
                <span className="menu-pager-name">
                  {localized(lang, previous.name, previous.nameAr)}
                </span>
              </Link>
            ) : (
              // A placeholder, so the single remaining link does not slide
              // across into the space the missing one would have held.
              <span className="menu-pager-gap" aria-hidden="true" />
            )}
            {next ? (
              <Link className="menu-pager-link is-next" href={`/menu/${next.id}`} rel="next">
                <span className="menu-pager-dir">
                  {t.menuNextCategory}
                  <span className="menu-pager-arrow" aria-hidden="true">
                    →
                  </span>
                </span>
                <span className="menu-pager-name">{localized(lang, next.name, next.nameAr)}</span>
              </Link>
            ) : (
              <span className="menu-pager-gap" aria-hidden="true" />
            )}
          </nav>
        </div>
      </div>

      {/* No Suspense fallback element: the dialog animates in from nothing, and
          a spinner in its place would flash for a frame on a warm chunk. */}
      {everOpened && (
        <Suspense fallback={null}>
          <MenuItemDetail selection={selection} onClose={closeItem} />
        </Suspense>
      )}
    </main>
  );
}

/**
 * One category, as a section of the group's page.
 *
 * A component rather than a loop body inside `MenuPage`, and that is a
 * constraint rather than a preference: `useReveal` is a hook, so calling it once
 * per category inline would change the number of hooks the page runs when the
 * reader moves from Cookies (seven) to Drinks (four) — the one thing React
 * cannot survive. Giving each section its own component gives each its own
 * reveal, which is also the better effect: the sections arrive as the reader
 * reaches them instead of the whole page fading in at once.
 */
function Section({
  category,
  onOpen,
}: {
  category: MenuCategory;
  /** Handed the control as well as the item, so focus can be returned to it. */
  onOpen: (item: MenuItem, category: MenuCategory, trigger: HTMLElement) => void;
}) {
  const { t, lang } = useLang();
  const [listRef, listAnim] = useReveal<HTMLUListElement>(0);
  const name = localized(lang, category.name, category.nameAr);

  return (
    <section id={category.id} className="menu-section" aria-labelledby={`heading-${category.id}`}>
      <div className="menu-section-head">
        <h2 id={`heading-${category.id}`} className="menu-section-title">
          {name}
        </h2>
        <p className="menu-section-meta">
          {t.menuItemCount(category.items.length)}
          <span aria-hidden="true"> · </span>
          {t.menuPriceFrom(t.price(priceFrom(category)))}
        </p>
      </div>
      {/* A list, because it is one. A screen reader announcing "list, seven
          items" before a section is the fastest possible summary. */}
      <ul ref={listRef} className={cx("menu-items", listAnim.className)} style={listAnim.style}>
        {category.items.map((item) => {
          // The name the customer is reading, resolved once and used for both
          // the row and the cart line it creates.
          const itemName = localized(lang, item.name, item.nameAr);
          const note = item.note ? localized(lang, item.note, item.noteAr) : undefined;

          const photo = item.image ?? itemImage(item.id);

          return (
            <li key={item.id} className="menu-item">
              {/* The picture and the text are one button, and the add control
                  is its sibling rather than its child. A `<button>` inside a
                  `<button>` is invalid HTML and browsers recover by lifting the
                  inner one out of the outer, which produces a tree that does
                  not match what React rendered. Same arrangement the rail cards
                  on the home page use, for the same reason. */}
              <button
                type="button"
                className="menu-item-open"
                onClick={(event) => onOpen(item, category, event.currentTarget)}
                aria-haspopup="dialog"
                aria-label={t.menuDetailOpen(itemName)}
              >
              {/* The media box is rendered for every row, photographed or not.
                  A column where only some rows carry a picture reads as a page
                  that failed to load the rest, and the ragged left edge is
                  worse than the missing photographs — so an unshot item gets
                  the branded tile below at exactly the same size.

                  `alt=""` on purpose. The item's name sits immediately beside
                  the picture, so alt text here would make a screen reader say
                  every product twice; an empty alt is what marks it as carried
                  by the adjacent text rather than as an unlabelled image. */}
              <span className={cx("menu-item-media", !photo && "is-empty")}>
                {photo ? (
                  <img
                    src={photo}
                    alt=""
                    width={320}
                    height={320}
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="9" cy="9.5" r="1.4" className="chip" />
                    <circle cx="15" cy="11" r="1.1" className="chip" />
                    <circle cx="11" cy="15" r="1.2" className="chip" />
                  </svg>
                )}
              </span>

              {/* Name over price, with the picture beside them — the shape a
                  delivery-app listing has, which is what this page was asked to
                  read like. The dotted leader the row used to carry is gone
                  with it: a leader exists to carry the eye across empty space
                  to a price on the far edge, and there is no empty space left
                  once the price sits under the name. */}
              <span className="menu-item-text">
                <span className="menu-item-name">
                  {itemName}
                  {note ? <span className="menu-item-note">{note}</span> : null}
                </span>
                <span className="menu-item-price">
                  {t.price(item.price)}
                  {item.soldOut ? <> · {t.soldOut}</> : null}
                </span>
              </span>
              </button>

              {/* Trailing, in the one part of the row that is still empty by
                  design, so revealing it on hover displaces nothing. On touch
                  it is always there; see AddToCart.

                  Skipped for an item with flavor choices: a quick add here
                  would put the printed shorthand — "Vanilla, Red Velvet or
                  Chocolate" — straight into the cart with no flavor picked.
                  Opening the row is still the way in; the dialog is where the
                  choice and the real add-to-cart control live. */}
              {!item.choices?.length && !item.soldOut && item.bundle?.type !== "choice" && (
                <AddToCart
                  className="menu-item-add"
                  item={{
                    productId: item.id,
                    name: itemName,
                    price: item.price,
                    ...(note ? { note } : {}),
                    ...(photo ? { image: photo } : {}),
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Scroll a horizontal bar so one of its children is centred.
 *
 * Deliberately not `scrollIntoView`: that scrolls every scrollable ancestor,
 * the page included, so on arrival it would drag the viewport down to the bar
 * instead of leaving the reader where they are. Only the bar's own horizontal
 * offset is touched here.
 *
 * Right-to-left scroll containers count backwards. `scrollLeft` is 0 at the
 * *start* — which in Arabic is the right-hand end — and runs down to
 * -(scrollWidth - clientWidth) at the far left. Two consequences, and the
 * original code was wrong about both:
 *
 *  1. A raw rect difference lands short of the child's real distance from the
 *     content's left edge, because the rect measurement is physical while
 *     `scrollLeft` is signed.
 *  2. `Math.max(0, …)` clamps every target to zero, since every valid RTL
 *     scroll position except the very start *is* negative. The bar simply never
 *     moved in Arabic, and the active pill stayed off screen.
 *
 * So the sum is normalised to one direction-free quantity — how much content is
 * hidden past the left edge, always 0…max — the centring is done in that space,
 * and the result is converted back at the end.
 */
function centre(scroller: HTMLElement, child: HTMLElement, behavior: ScrollBehavior): void {
  const rtl = getComputedStyle(scroller).direction === "rtl";
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const hiddenLeft =
    child.getBoundingClientRect().left
    - scroller.getBoundingClientRect().left
    + scroller.scrollLeft
    + (rtl ? max : 0);

  const centred = hiddenLeft - (scroller.clientWidth - child.offsetWidth) / 2;
  const clamped = Math.min(max, Math.max(0, centred));
  scroller.scrollTo({ left: rtl ? clamped - max : clamped, behavior });
}
