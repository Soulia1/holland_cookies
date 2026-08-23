import { cx, useReveal } from "@/lib/reveal";

const FACTS = [
  { title: "Hours", body: "Daily · 11:00 – 01:00" },
  { title: "Pickup", body: "Nasr City, Cairo" },
  { title: "Delivery", body: "Across greater Cairo" },
];

/**
 * The closing call to action.
 *
 * The two ways to actually order are real links — `tel:` and a WhatsApp
 * handoff — rather than a form posting to a backend this project does not have.
 * A form that silently goes nowhere is worse than no form.
 */
export default function Visit() {
  const [ref, anim] = useReveal<HTMLDivElement>(0);

  return (
    <section className="bg-surface-container py-20 md:py-[80px] lg:py-[120px]" id="visit">
      <div className="max-w-4xl mx-auto px-5 md:px-12">
        <div
          ref={ref}
          className={cx(
            "text-center bg-soft-oat rounded-2xl p-8 md:p-12 shadow-sm border border-outline-variant/20",
            anim.className,
          )}
          style={anim.style}
        >
          <h2 className="font-display text-[32px] leading-[40px] md:text-[52px] md:leading-[60px] font-semibold text-primary mb-5">
            Warm cookies, ready today
          </h2>
          <p className="font-body text-[18px] md:text-[20px] leading-[30px] md:leading-[32px] text-on-surface-variant mb-10 md:mb-12 max-w-2xl mx-auto">
            Order a pan for pickup or same-day delivery. Custom boxes for parties
            available with 24 hours notice.
          </p>

          <div className="flex flex-col sm:flex-row justify-center gap-3 sm:gap-4 mb-12 md:mb-16">
            <a
              href="tel:+201000000000"
              className="btn btn-lift bg-deep-burgundy text-white font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-8 py-4 rounded-sm"
            >
              Call to order
            </a>
            <a
              href="https://wa.me/201000000000"
              target="_blank"
              rel="noreferrer noopener"
              className="btn bg-white border border-outline-variant text-primary font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-8 py-4 rounded-sm hover:bg-surface-container-low"
            >
              WhatsApp us
            </a>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-8 text-center pt-10 md:pt-12 border-t border-outline-variant/30">
            {FACTS.map((fact) => (
              <div key={fact.title}>
                <dt className="font-display text-[19px] md:text-[20px] font-semibold text-primary mb-1.5">
                  {fact.title}
                </dt>
                <dd className="font-body text-[16px] leading-[26px] text-secondary">
                  {fact.body}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
