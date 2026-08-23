import { useEffect, useRef, useState } from "react";
import { holdSplash, setSplashProgress, type SplashExitReason } from "@/lib/splash";

/**
 * The hero.
 *
 * Its photograph is the one asset this page is visibly wrong without, so the
 * boot splash is held over the page until that image has *decoded* — not merely
 * loaded. Uncovering the page before then hands the visitor a finished-looking
 * site with an empty rectangle where the product should be, and the product
 * then pops in a beat later.
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

const HERO_IMAGE = "/img/hero-main.jpg";
const INSET_IMAGE = "/img/hero-float.jpg";

/**
 * Resolve once the hero photograph has decoded, or immediately if it cannot.
 *
 * `decode()` is what separates "the bytes arrived" from "the browser can paint
 * this without stalling". Drawing an image that has loaded but not decoded costs
 * a synchronous decode on first paint, which lands exactly when the splash is
 * lifting.
 */
function decodeHeroImage(): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.src = HERO_IMAGE;

    // A cached image can already be complete before decode() is reached; the
    // promise still resolves, so this needs no special case.
    if (typeof img.decode === "function") {
      img.decode().then(() => resolve()).catch(() => resolve());
      return;
    }
    img.onload = () => resolve();
    img.onerror = () => resolve();
  });
}

export default function Hero() {
  const [ready, setReady] = useState(false);
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

    void decodeHeroImage().then(() => {
      if (cancelled) return;
      setSplashProgress(1);
      setReady(true);
      release.current?.("hero-ready");
    });

    return () => {
      cancelled = true;
      window.clearTimeout(ceiling);
      release.current?.();
      release.current = null;
    };
  }, []);

  return (
    <section
      id="top"
      className="max-w-[1440px] mx-auto px-5 md:px-12 pt-28 md:pt-32 pb-20 md:pb-[80px] lg:pb-[120px]"
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-[32px] items-center">
        {/* The copy leads. It is real text in the markup, never keyed to the
            image's arrival — a visitor who lands and does not scroll must still
            be told what this place sells. */}
        <div className="lg:col-span-5 z-10 flex flex-col items-start gap-6 hero-in">
          <span className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-deep-burgundy">
            Baked fresh in Cairo
          </span>
          <h1 className="font-display text-[48px] leading-[52px] lg:text-[84px] lg:leading-[92px] font-bold tracking-[-0.02em] text-primary">
            Cookie pies with a{" "}
            <em className="text-deep-burgundy font-semibold italic">molten</em> heart.
          </h1>
          <p className="font-body text-[20px] leading-[32px] text-on-surface-variant max-w-md">
            Thick, hand-stuffed pans of soft cookie dough and warm chocolate — pulled
            from the oven the moment you order.
          </p>
          <div className="flex flex-wrap items-center gap-4 mt-2">
            <a
              href="#menu"
              className="btn btn-lift bg-deep-burgundy text-white font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-8 py-4 rounded-sm"
            >
              See the menu
            </a>
            <a
              href="#visit"
              className="btn border border-primary text-primary font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-8 py-4 rounded-sm hover:bg-primary/5"
            >
              Find us
            </a>
          </div>
        </div>

        <div className="lg:col-span-7 relative mt-8 lg:mt-0">
          <div
            /* 3:2 rather than a square or 4:3. The source photographs are
               1408x768 — a shade under 16:9 — so a squarer box throws away most
               of their width and then magnifies what is left. Matching the
               source more closely is what keeps them sharp. */
            className={`hero-plate relative w-full aspect-[3/2] rounded-xl overflow-hidden bg-surface-container ${
              ready ? "" : "opacity-0"
            }`}
          >
            <img
              src={HERO_IMAGE}
              alt="A thick chocolate chip cookie pie in an aluminium pan, with pools of melted milk chocolate on top."
              className="w-full h-full object-cover"
              width={1408}
              height={768}
              /* Eager and high priority: this is the largest contentful paint
                 candidate and the asset the splash is waiting on. Lazy-loading
                 it would hold the loader open waiting for a request the browser
                 has been told not to make yet. */
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </div>

          {/* A second, smaller photograph overlapping the plate. Pure decoration,
              so it is lazy and carries an empty alt — describing it would only
              add noise to a screen reader that has already been told what the
              hero shows. */}
          <div className="hero-inset absolute -bottom-8 -left-4 md:-bottom-12 md:-left-12 w-40 md:w-64 rounded-lg overflow-hidden border-4 border-soft-oat shadow-2xl shadow-primary/10">
            <img
              src={INSET_IMAGE}
              alt=""
              aria-hidden="true"
              className="w-full h-auto object-cover"
              width={1408}
              height={768}
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>
      </div>

      {/* Stats. Sits well below the fold on a phone, so it is a scroll reveal
          rather than part of the hero's entrance. */}
      <dl className="grid grid-cols-3 gap-4 sm:gap-8 mt-28 md:mt-32 border-t border-outline-variant/30 pt-10 md:pt-12 max-w-3xl">
        {[
          { value: "Daily", label: "Fresh bakes" },
          { value: "100%", label: "Real butter" },
          { value: "4.9★", label: "Guest rating" },
        ].map((stat) => (
          <div key={stat.label}>
            <dt className="sr-only">{stat.label}</dt>
            <dd>
              <span className="block font-display text-[26px] sm:text-[32px] leading-[1.2] font-semibold text-dutch-navy mb-1">
                {stat.value}
              </span>
              <span className="font-body text-[11px] sm:text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary">
                {stat.label}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
