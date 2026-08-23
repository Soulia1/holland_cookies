import { cx, useReveal } from "@/lib/reveal";

const STEPS = [
  {
    n: "01",
    title: "Mixed by hand",
    body: "Small batches, real butter, no shortcuts, every morning.",
  },
  {
    n: "02",
    title: "Stuffed generously",
    body: "A molten core of chocolate sealed inside every pan.",
  },
  {
    n: "03",
    title: "Baked to order",
    body: "Out of the oven and into your box while still warm.",
  },
];

/**
 * The dark band.
 *
 * The one section that inverts the palette, which is what makes it read as a
 * pause rather than another row of content. Its photograph and its copy reveal
 * as two separate groups so the image is not still sliding while the reader has
 * already started the first line.
 */
export default function Craft() {
  const [imageRef, imageAnim] = useReveal<HTMLDivElement>(0);
  const [copyRef, copyAnim] = useReveal<HTMLDivElement>(1);

  return (
    <section className="bg-dutch-navy text-white py-20 md:py-[80px] lg:py-[120px]" id="craft">
      <div className="max-w-[1440px] mx-auto px-5 md:px-12">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-24 items-center">
          <div
            ref={imageRef}
            className={cx("order-2 lg:order-1", imageAnim.className)}
            style={imageAnim.style}
          >
            {/* Landscape, not the 4:5 portrait this started as. Cropping a
                1408x768 photograph into a portrait box left only ~614px of
                source for a slot twice that wide — soft at any download size.
                The aspect ratio was the problem, not the resolution. */}
            <div className="aspect-[4/3] rounded-xl overflow-hidden bg-tertiary-container shadow-2xl shadow-black/20">
              <img
                src="/img/craft-box.jpg"
                alt="Three cookie pies in silver pans arranged in a white bakery box, seen from above."
                className="w-full h-full object-cover opacity-95"
                width={1408}
                height={768}
                loading="lazy"
                decoding="async"
              />
            </div>
          </div>

          <div
            ref={copyRef}
            className={cx("order-1 lg:order-2", copyAnim.className)}
            style={copyAnim.style}
          >
            <span className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-tertiary-fixed-dim mb-4 block">
              Our craft
            </span>
            <h2 className="font-display text-[40px] leading-[46px] lg:text-[72px] lg:leading-[80px] font-bold tracking-[-0.02em] text-white mb-6 md:mb-8">
              Dutch heart, Cairo oven.
            </h2>
            <p className="font-body text-[18px] md:text-[20px] leading-[30px] md:leading-[32px] text-inverse-primary/80 mb-10 md:mb-12">
              Holland Cookies started with one stubborn idea: a cookie should be thick
              enough to need a fork and warm enough to pull apart. Everything is folded
              by hand in small batches, baked in individual pans, and never left to sit.
            </p>

            <ol className="space-y-7 md:space-y-8">
              {STEPS.map((step) => (
                <li key={step.n} className="flex gap-5 md:gap-6 items-start group">
                  <span
                    className="craft-step-num font-display text-[28px] md:text-[32px] leading-none font-normal text-tertiary-fixed-dim opacity-50 group-hover:opacity-100"
                    aria-hidden="true"
                  >
                    {step.n}
                  </span>
                  <div>
                    <h3 className="font-display text-[22px] md:text-[24px] leading-[1.3] font-semibold text-white mb-1.5">
                      {step.title}
                    </h3>
                    <p className="font-body text-[16px] leading-[26px] text-inverse-primary/70">
                      {step.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
