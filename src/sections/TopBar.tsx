import { useEffect, useState } from "react";

/**
 * The bar's own height, and the line the menu has to cross for the bar to take
 * its background.
 */
const HEADER_HEIGHT = 88;

const LINKS = [
  { href: "#menu", label: "Menu" },
  { href: "#craft", label: "Our Craft" },
  { href: "#visit", label: "Visit" },
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
  const [solid, setSolid] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
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
  }, []);

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

  return (
    <header
      className={`site-header fixed top-0 w-full z-50 ${
        solid
          ? "bg-soft-oat/92 backdrop-blur-md shadow-[0_1px_0_0_rgb(211_195_192/0.5)]"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-[1440px] mx-auto flex justify-between items-center px-5 md:px-12 py-5 md:py-6">
        <a href="#top" className="flex-shrink-0" aria-label="Holland Cookies, back to top">
          <img
            src="/img/logo.jpg"
            alt="Holland Cookies"
            className="h-10 md:h-12 w-auto object-contain"
            width={160}
            height={48}
          />
        </a>

        <nav className="hidden md:flex items-center gap-8" aria-label="Primary">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary hover:text-deep-burgundy transition-colors duration-300"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <a
          href="#visit"
          className="btn btn-lift hidden md:inline-flex items-center justify-center bg-deep-burgundy text-white font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-6 py-3 rounded-sm"
        >
          Order Now
        </a>

        <button
          type="button"
          className="btn md:hidden text-deep-burgundy p-2 -mr-2"
          aria-expanded={menuOpen}
          aria-controls="mobile-menu"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {/* Drawn rather than pulled from an icon font: two rules of CSS beat a
              render-blocking stylesheet and a font file for six pixels of line. */}
          <span className="relative block w-6 h-4" aria-hidden="true">
            <span
              className={`absolute left-0 block h-[2px] w-6 bg-current transition-transform duration-300 ${
                menuOpen ? "top-[7px] rotate-45" : "top-0"
              }`}
            />
            <span
              className={`absolute left-0 top-[7px] block h-[2px] w-6 bg-current transition-opacity duration-200 ${
                menuOpen ? "opacity-0" : "opacity-100"
              }`}
            />
            <span
              className={`absolute left-0 block h-[2px] w-6 bg-current transition-transform duration-300 ${
                menuOpen ? "top-[7px] -rotate-45" : "top-[14px]"
              }`}
            />
          </span>
        </button>
      </div>

      {/* The panel is always in the DOM and animated by grid-template-rows, so
          the height is whatever the content needs rather than a max-height
          guess that either stalls or clips. `inert` keeps its links out of the
          tab order while it is closed — a collapsed panel that is still
          focusable is a keyboard trap that sighted users never encounter. */}
      <div
        id="mobile-menu"
        className={`mobile-menu md:hidden ${menuOpen ? "is-open" : ""} ${
          solid || menuOpen ? "bg-soft-oat/97 backdrop-blur-md" : "bg-soft-oat/92 backdrop-blur-md"
        }`}
        {...(!menuOpen ? { inert: "" as unknown as boolean } : {})}
      >
        <div>
          <nav
            className="flex flex-col px-5 pb-6 pt-2 gap-1 border-t border-outline-variant/30"
            aria-label="Mobile"
          >
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="font-body text-[13px] font-semibold uppercase tracking-[0.15em] text-primary py-3 active:opacity-60 transition-opacity"
              >
                {link.label}
              </a>
            ))}
            <a
              href="#visit"
              onClick={() => setMenuOpen(false)}
              className="btn mt-3 inline-flex items-center justify-center bg-deep-burgundy text-white font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-6 py-4 rounded-sm"
            >
              Order Now
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}
