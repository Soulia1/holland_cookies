import { useEffect, useRef, useState } from "react";
import CrumbField from "@/components/CrumbField";
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
 * The pan, cut to a circle on transparency.
 *
 * Three formats of one 762px source, offered widest-support-last so the browser
 * takes the smallest it understands: AVIF 128KB, WebP 226KB, PNG 1.2MB. The PNG
 * exists only so a browser with neither modern format still gets the product;
 * it is never the file a current browser downloads, which is also why there is
 * no 2x PNG — that file is 4MB, and nothing that would fall back to it wants it.
 *
 * 762px is the source's own resolution: the photograph is 1408x768 and the pan
 * occupies a 762px circle within it. So the CSS width is capped near that (see
 * `--pan-size`), and the 2x rendition is an offline Lanczos-plus-unsharp
 * upscale rather than more detail — a retina display is going to resample this
 * to 1360 device pixels regardless, and doing it once with a good kernel beats
 * the browser doing it every paint with a cheap one. Softness here is a limit of
 * the photograph, not of the layout.
 */
const PAN_PNG = "/img/cookie-plate.png";

export default function Hero() {
  const [ready, setReady] = useState(false);
  const panRef = useRef<HTMLImageElement>(null);
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
    // waiting for or downloading a 1.2MB PNG alongside the 128KB AVIF the page
    // is really using.
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

  return (
    <section id="top" className="hero">
      {/* The copy leads. It is real text in the markup, never keyed to the
          image's arrival — a visitor who lands and does not scroll must still
          be told what this place sells. */}
      <div className={`hero-copy ${ready ? "is-in" : ""}`}>
        <h1 className="hero-title">
          Your Cookie Party
          <br />
          Starts Here!
        </h1>
        <p className="hero-sub">
          Gather your friends and family around the warmest pan in Cairo. Hand-stuffed
          with molten chocolate, baked to order and delivered hot.
        </p>
        <a className="hero-cta btn" href="#menu">
          View Our Menu
        </a>
      </div>

      {/* The pan. Absolutely placed against the bottom of the section and
          allowed to run past it, so the section's own overflow does the
          cropping — the alternative, sizing a wrapper to the visible sliver and
          positioning the image inside it, needs a second number kept in step
          with the first every time the size changes. */}
      <div className={`hero-stage ${ready ? "is-in" : ""}`}>
        <span className="hero-pan-shadow" aria-hidden="true" />
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
            alt="A thick chocolate chip cookie pie in an aluminium pan, its surface pooled with melted milk chocolate."
            className="hero-pan"
            width={762}
            height={762}
            /* Eager and high priority: this is the largest contentful paint
               candidate and the asset the splash is waiting on. Lazy-loading it
               would hold the loader open waiting for a request the browser has
               been told not to make yet. */
            loading="eager"
            fetchPriority="high"
            decoding="async"
          />
        </picture>
      </div>

      <CrumbField armed={ready} />
    </section>
  );
}
