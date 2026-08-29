import { useEffect, useState } from "react";
import AccountButton from "@/components/AccountButton";
import CartButton from "@/components/CartButton";
import LangSwitch from "@/components/LangSwitch";
import { useLang, type Translations } from "@/lib/i18n";
import { Link, usePath } from "@/lib/router";

/**
 * The bar's own height, and the line the menu has to cross for the bar to take
 * its background.
 */
const HEADER_HEIGHT = 88;

// Absolute, not fragment-only. These have to work from `/menu` as well as from
// the home page, and `#craft` there points at a section that is not rendered.
//
// The label is a *key* rather than a string: a link list built with the text
// baked in is captured at module load, before any language is known, and would
// stay in whichever language happened to be first. Resolving it per render is
// what lets the nav change language without the module being re-evaluated.
const LINKS: { href: string; label: keyof Translations }[] = [
  { href: "/menu", label: "navMenu" },
  { href: "/#boxes", label: "navBuildBox" },
  { href: "/#craft", label: "navCraft" },
];

/**
 * The header.
 *
 * Rides transparently over the hero and only takes its background once the menu
 * reaches it. Over the hero there is nothing for an opaque bar to separate the
 * nav from — it just cuts a slab out of the top of the photograph — but from the
 * menu down the nav sits over product photography and cards, where see-through
 * text would be unreadable.
 *
 * The state is answered by an IntersectionObserver rather than by measuring on
 * every scroll event. The obvious implementation runs on every scroll tick and,
 * for each one, does a getBoundingClientRect — a forced synchronous layout in
 * the middle of scrolling, on the main thread — and then sets state whether or
 * not the answer changed. An observer answers the same question off the main
 * thread and only calls back when it actually crosses the threshold.
 */
export default function TopBar() {
  const path = usePath();
  const { t } = useLang();
  // The transparent bar exists to sit over the hero photograph. Away from the
  // home page there is no hero, so there is nothing for it to be transparent
  // over — only the first line of a heading showing through it.
  const onHome = path === "/";
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!onHome) return;
    // The *hero* is what is watched, not a marker at the top of the menu.
    //
    // A zero-height or one-pixel sentinel is the obvious way to do this and it
    // is subtly broken: an IntersectionObserver only calls back when a threshold
    // is crossed, and a visitor who jumps — an anchor link, a restored scroll
    // position, a find-in-page — moves that marker from below the viewport to
    // above it in one step without ever intersecting. The ratio goes 0 → 0, no
    // callback fires, and the header keeps whatever state it happened to have.
    // In practice that meant following "Visit" from the top of the page left a
    // transparent bar sitting over the content.
    //
    // The hero is a full screen tall, so any jump past it necessarily changes
    // whether it intersects, and the callback always fires. It is also
    // unambiguous in a way a mid-page marker is not: the hero is the first thing
    // in the document, so it can only ever be at or above the viewport — there
    // is no "not yet reached" case to confuse with "already passed".
    let observer: IntersectionObserver | null = null;
    let watched: Element | null = null;

    const attach = () => {
      const hero = document.getElementById("top");
      if (!hero || hero === watched) return;
      observer?.disconnect();
      watched = hero;
      observer = new IntersectionObserver(
        ([entry]) => {
          // The bar goes solid once the hero has left the strip beneath it.
          // Read the side rather than `isIntersecting`, so the answer is a
          // position rather than an inference. `boundingClientRect` is measured
          // by the observer and handed over on the entry, so this still costs no
          // main-thread layout.
          setSolid(entry.boundingClientRect.bottom <= HEADER_HEIGHT);
        },
        // The root is the viewport with its top HEADER_HEIGHT trimmed off, so
        // the hero stops intersecting at exactly the moment its bottom edge
        // passes under the bar.
        { rootMargin: `-${HEADER_HEIGHT}px 0px 0px 0px`, threshold: 0 },
      );
      observer.observe(hero);
    };

    attach();
    const mutation = new MutationObserver(attach);
    mutation.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      mutation.disconnect();
    };
  }, [onHome]);

  // Escape closes the mobile menu. A panel that can only be dismissed by
  // finding the button again is a trap for anyone on a keyboard.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // Close on resize past the breakpoint, so a menu opened on a phone does not
  // stay latched open behind the desktop nav after a rotation.
  useEffect(() => {
    if (!menuOpen) return;
    const onResize = () => {
      if (window.innerWidth >= 768) setMenuOpen(false);
    };
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [menuOpen]);

  const opaque = solid || !onHome;

  return (
    <header
      className={`site-header fixed top-0 w-full z-50 ${
        opaque
          ? "bg-soft-oat shadow-[0_1px_0_0_rgb(211_195_192/0.6)]"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-[1440px] mx-auto flex justify-between items-center px-5 md:px-10 py-5 md:py-6">
        <Link href="/" className="wordmark" aria-label={t.brandHome}>
          {/* The real mark, lifted off its white card by docs/cut-logo.py.
              `logo.jpg` is a screenshot: a white rectangle with rounded black
              corners and a leaf watermark, all of which showed as a patch over
              the hero cream. The transparent rendition is what makes it read as
              printed on the page rather than pasted onto it.

              Width and height are the trimmed bitmap's own, so the row cannot
              reflow when it loads; eager, because it is in the first screen and
              the header would otherwise settle a beat after everything else. */}
          <picture>
            <source srcSet="/img/logo.webp" type="image/webp" />
            <img
              src="/img/logo.png"
              alt="Holland Cookies"
              width={577}
              height={303}
              loading="eager"
              decoding="async"
            />
          </picture>
        </Link>

        {/* Three quiet links and nothing else, as in the reference. The header
            carries no call to action because the hero underneath it is one
            enormous call to action — a second button eight pixels above it is
            not a choice, it is noise. */}
        <div className="flex items-center gap-4 md:gap-7">
          <nav className="hidden md:flex items-center gap-9" aria-label={t.navPrimary}>
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="font-body text-[13px] font-medium tracking-[0.01em] text-secondary hover:text-deep-burgundy transition-colors duration-300"
              >
                {t[link.label] as string}
              </Link>
            ))}
          </nav>

          <LangSwitch className="hidden md:flex" />

          <AccountButton />

          {/* On a phone this sits beside the hamburger rather than inside the
              panel behind it: a cart you have to open a menu to reach is a cart
              you forget you filled. */}
          <CartButton />

          <button
            type="button"
            className="btn md:hidden text-deep-burgundy p-2 -me-2"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
            aria-label={menuOpen ? t.navCloseMenu : t.navOpenMenu}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {/* Drawn rather than pulled from an icon font: two rules of CSS beat
                a render-blocking stylesheet and a font file for six pixels of
                line. `start-0` rather than `left-0` so the bars stay anchored to
                the leading edge when the document flips to RTL. */}
            <span className="relative block w-6 h-4" aria-hidden="true">
              <span
                className={`absolute start-0 block h-[2px] w-6 bg-current transition-transform duration-300 ${
                  menuOpen ? "top-[7px] rotate-45" : "top-0"
                }`}
              />
              <span
                className={`absolute start-0 top-[7px] block h-[2px] w-6 bg-current transition-opacity duration-200 ${
                  menuOpen ? "opacity-0" : "opacity-100"
                }`}
              />
              <span
                className={`absolute start-0 block h-[2px] w-6 bg-current transition-transform duration-300 ${
                  menuOpen ? "top-[7px] -rotate-45" : "top-[14px]"
                }`}
              />
            </span>
          </button>
        </div>
      </div>

      {/* The panel is always in the DOM and animated by grid-template-rows, so
          the height is whatever the content needs rather than a max-height
          guess that either stalls or clips. `inert` keeps its links out of the
          tab order while it is closed — a collapsed panel that is still
          focusable is a keyboard trap that sighted users never encounter. */}
      <div
        id="mobile-menu"
        className={`mobile-menu md:hidden ${menuOpen ? "is-open" : ""} ${
          "bg-soft-oat"
        }`}
        {...(!menuOpen ? { inert: "" as unknown as boolean } : {})}
      >
        <div>
          <nav
            className="flex flex-col px-5 pb-6 pt-2 gap-1 border-t border-outline-variant/30"
            aria-label={t.navMobile}
          >
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="font-body text-[13px] font-semibold uppercase tracking-[0.15em] text-primary py-3 active:opacity-60 transition-opacity"
              >
                {t[link.label] as string}
              </Link>
            ))}

            <LangSwitch className="mt-2 self-start" />
            <a
              href="/#boxes"
              onClick={() => setMenuOpen(false)}
              className="btn mt-3 inline-flex items-center justify-center bg-deep-burgundy text-white font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-6 py-4 rounded-sm"
            >
              {t.navOrderNow}
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}
