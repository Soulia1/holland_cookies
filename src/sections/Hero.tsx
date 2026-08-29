import { useEffect, useRef, useState } from "react";
import CrumbField from "@/components/CrumbField";
import { useLang } from "@/lib/i18n";
import { Link } from "@/lib/router";
import { useCapability } from "@/lib/motion/useCapability";
import { holdSplash, setSplashProgress, type SplashExitReason } from "@/lib/splash";

/**
 * The hero.
 *
 * One screen: centred copy over a single enormous pan that bleeds off the
 * bottom edge, with ingredients drifting around it. The composition is taken
 * from the reference recording — the product is the floor of the page rather
 * than a picture sitting in a column beside the text, which is what lets it be
 * this big without crowding anything.
 *
 * Its photograph is the one asset this page is visibly wrong without, so the
 * boot splash is held over the page until that image has *decoded* — not merely
 * loaded. Uncovering the page before then hands the visitor a finished-looking
 * site with an empty hole where the product should be, and the product then
 * pops in a beat later.
 *
 * Scooby's hero solved the same problem for a scroll-scrubbed frame sequence.
 * There is no sequence here — this design has one still photograph — so the
 * mechanism is kept and the subject changed: same hold, same ceiling, same
 * single exit, one image instead of forty-eight frames.
 */

/**
 * How long the splash will wait for the photograph before giving up on it.
 *
 * A ceiling, not a delay — on any ordinary connection the image is in well
 * inside it. It exists because the alternative to a cap is a visitor on a bad
 * connection staring at a loading screen for as long as their connection takes,
 * with a complete page sitting underneath it the whole time. When it fires the
 * visitor gets the hero with its image still arriving, which is a complete hero
 * in every other respect.
 *
 * Comfortably inside the `is-held` failsafe in index.html, which must remain
 * longer than this.
 */
const IMAGE_WAIT_CEILING_MS = 8000;

/**
 * How far the pan turns across one screen of scrolling, in degrees.
 *
 * Small on purpose. The pan is a photograph of a real object, and a real object
 * that spins as you scroll reads as a gimmick; at a quarter of this it is
 * imperceptible, at four times it the chocolate pools visibly swing. Twenty-six
 * degrees is enough that the surface is demonstrably not a static picture and
 * little enough that nobody catches it being one.
 */
const SCROLL_SPIN_DEG = 26;

/**
 * The pan, cut to a circle on transparency.
 *
 * Three formats of one 762px source, offered widest-support-last so the browser
 * takes the smallest it understands: AVIF, WebP, PNG. The PNG exists only so a
 * browser with neither modern format still gets the product; it is never the
 * file a current browser downloads, which is also why there is no 2x PNG —
 * that file is 4MB, and nothing that would fall back to it wants it.
 *
 * 762px is the source's own resolution: the photograph is 1408x768 and the pan
 * occupies a 762px circle within it. `--pan-size` is capped at 760px so a 2x
 * display asks for 1520 device pixels against a 1524px rendition — near enough
 * 1:1 that the browser is not resampling at all — while a 1x display downscales,
 * which is always sharp. See docs/cut-plate.py for how the renditions are built.
 */
const PAN_PNG = "/img/cookie-plate.png";

export default function Hero() {
  const { t } = useLang();
  const [ready, setReady] = useState(false);
  const { reduced } = useCapability();
  const panRef = useRef<HTMLImageElement>(null);
  const spinRef = useRef<HTMLDivElement>(null);
  const release = useRef<((reason?: SplashExitReason) => void) | null>(null);

  useEffect(() => {
    release.current = holdSplash();
    let cancelled = false;

    // A coarse two-step rather than real per-byte progress. There is one image,
    // so there is nothing finer to report; the bar exists to show the wait is
    // bounded, not to be a byte counter.
    setSplashProgress(0.35);

    const ceiling = window.setTimeout(() => {
      release.current?.("hero-wait-ceiling");
    }, IMAGE_WAIT_CEILING_MS);

    const done = () => {
      if (cancelled) return;
      setSplashProgress(1);
      setReady(true);
      release.current?.("hero-ready");
    };

    // Gated on the rendered element rather than on a `new Image()` with a
    // hard-coded URL. The pan is served through <picture>, so which of the three
    // files is actually fetched is the browser's decision — a second Image()
    // would guess, and guessing wrong means either gating on a file nothing is
    // waiting for or downloading a 1.2MB PNG alongside the AVIF the page is
    // really using.
    //
    // `decode()` is also what separates "the bytes arrived" from "the browser
    // can paint this without stalling". Drawing an image that has loaded but
    // not decoded costs a synchronous decode on first paint, which lands exactly
    // when the splash is lifting.
    const pan = panRef.current;
    if (pan && typeof pan.decode === "function") {
      pan.decode().then(done, done);
    } else if (pan) {
      if (pan.complete) done();
      else {
        pan.addEventListener("load", done, { once: true });
        pan.addEventListener("error", done, { once: true });
      }
    } else {
      done();
    }

    return () => {
      cancelled = true;
      window.clearTimeout(ceiling);
      release.current?.();
      release.current = null;
    };
  }, []);

  /**
   * Turn the pan as the hero scrolls past.
   *
   * A scroll listener, which this project otherwise avoids — but the reason it
   * avoids them is that the naive version calls getBoundingClientRect on every
   * tick, forcing a synchronous layout in the middle of a scroll. This one never
   * measures anything at all: `scrollY` is free, the distance the turn is spread
   * over is the viewport height, and the only per-frame work is writing one
   * custom property. An IntersectionObserver cannot do this job, because the
   * question is not "is it on screen" but "how far through it are we".
   *
   * The viewport height rather than the hero's own measured height, and that is
   * load-bearing rather than lazy. The first version measured `.hero` once on
   * mount and got **12333px** — because at mount the stylesheet has not applied
   * (`document.styleSheets.length` is 0 there), so it measured eight unstyled
   * SVGs stacked in normal flow. The turn then ran at a fourteenth of its
   * intended rate, and nothing about that was visible; it just looked like the
   * effect was very subtle. The hero is exactly one viewport tall by
   * construction — pinned by the "fits one screen" e2e test — so the viewport
   * height is the same number without the measurement, and without the class of
   * bug that comes with reading layout before styles exist.
   *
   * Skipped outright under reduced motion. This is page-initiated movement the
   * visitor did not ask for and cannot stop from inside the page.
   */
  useEffect(() => {
    const node = spinRef.current;
    if (!node) return;
    if (reduced) {
      node.style.removeProperty("--pan-spin");
      return;
    }

    let frame = 0;

    const apply = () => {
      frame = 0;
      const span = window.innerHeight || 1;
      const progress = Math.min(1, Math.max(0, window.scrollY / span));
      node.style.setProperty("--pan-spin", `${(progress * SCROLL_SPIN_DEG).toFixed(2)}deg`);
    };

    const onScroll = () => {
      // Coalesced to one write per frame. Scroll events can outpace frames
      // several times over, and every extra write is a style recalculation for
      // a value that is about to be overwritten anyway.
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    // Resize and rotation change innerHeight, so the turn has to be recomputed
    // for the position the page is already at.
    window.addEventListener("resize", onScroll, { passive: true });
    window.addEventListener("orientationchange", onScroll, { passive: true });

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("orientationchange", onScroll);
    };
  }, [reduced]);

  return (
    <section id="top" className="hero">
      {/* The copy leads. It is real text in the markup, never keyed to the
          image's arrival — a visitor who lands and does not scroll must still
          be told what this place sells. */}
      <div className={`hero-copy ${ready ? "is-in" : ""}`}>
        <h1 className="hero-title">
          {t.heroTitleLine1}
          <br />
          {t.heroTitleLine2}
        </h1>
        <p className="hero-sub">{t.heroSub}</p>
        <Link className="hero-cta btn" href="/menu">
          {t.heroCta}
        </Link>
      </div>

      {/* The pan.
          Four nested elements, one transform each, because they run on four
          different clocks: the stage arrives once, the spin wrapper follows the
          scroll, the entry wrapper turns once on load, and the image drifts for
          ever. Put any two of those on one element and the later one restarts
          the earlier from wherever it happened to be. */}
      <div className={`hero-stage ${ready ? "is-in" : ""}`}>
        <span className="hero-pan-shadow" aria-hidden="true" />
        <div className="hero-pan-spin" ref={spinRef}>
          <div className="hero-pan-entry">
            <picture>
              <source
                type="image/avif"
                srcSet="/img/cookie-plate.avif 1x, /img/cookie-plate@2x.avif 2x"
              />
              <source
                type="image/webp"
                srcSet="/img/cookie-plate.webp 1x, /img/cookie-plate@2x.webp 2x"
              />
              <img
                ref={panRef}
                src={PAN_PNG}
                alt={t.heroPanAlt}
                className="hero-pan"
                width={762}
                height={762}
                /* Eager and high priority: this is the largest contentful paint
                   candidate and the asset the splash is waiting on. Lazy-loading
                   it would hold the loader open waiting for a request the
                   browser has been told not to make yet. */
                loading="eager"
                fetchPriority="high"
                decoding="async"
              />
            </picture>
          </div>
        </div>
      </div>

      <CrumbField armed={ready} />
    </section>
  );
}
