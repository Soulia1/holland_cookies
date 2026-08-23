// The product detail dialog.
//
// A bottom sheet on phones, a centred panel on wider screens. Built on Radix's
// Dialog rather than a bare fixed div, and that is not a styling preference:
// Radix supplies the focus trap, the return of focus to whatever opened the
// dialog, the aria-modal wiring and the inert background. Hand-rolled versions
// of this reliably miss at least one of those, and the usual casualty is the
// focus trap — a keyboard user tabs straight out of the open dialog and into
// the page behind it, with no way to tell where they are.
//
// Motion is Framer's rather than Radix's data-state CSS animations, so the
// entry and exit share the springs and durations in the motion tokens.

import { useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import type { Pan } from "@/data/pans";
import {
  duration,
  ease,
  spring,
  transitionFor,
  travel,
  travelFor,
} from "@/lib/motion/tokens";
import { useCapability } from "@/lib/motion/useCapability";

export default function PanDetail({
  pan,
  onClose,
}: {
  pan: Pan | null;
  onClose: () => void;
}) {
  const { reduced, coarse } = useCapability();
  const open = pan !== null;

  // Lock the page behind the dialog, and compensate for the scrollbar's width
  // so the content underneath does not shift sideways as it disappears. Radix
  // handles the aria side of the background; this is the visual half.
  useEffect(() => {
    if (!open) return;
    const width = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.setProperty("--scrollbar-width", `${width}px`);
    document.body.classList.add("is-locked");
    return () => {
      document.body.classList.remove("is-locked");
      document.documentElement.style.removeProperty("--scrollbar-width");
    };
  }, [open]);

  // On a phone the panel comes up from the bottom; on a desktop it scales into
  // the middle. Entering from the edge a thumb can reach is what makes a sheet
  // feel like it belongs to the device rather than to the page.
  // Reduced motion collapses the travel to zero and leaves the fade, rather
  // than each call site remembering to check the preference for itself.
  const hidden = coarse
    ? { y: reduced ? 0 : "100%", opacity: reduced ? 0 : 1, scale: 1 }
    : { y: travelFor(travel.panel, reduced), opacity: 0, scale: reduced ? 1 : 0.98 };
  const shown = { y: 0, opacity: 1, scale: 1 };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AnimatePresence>
        {open && pan && (
          // forceMount hands the unmount timing to AnimatePresence. Without it
          // Radix removes the content the instant `open` flips and the exit
          // animation never gets a chance to run.
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-[800] bg-primary/40 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transitionFor(
                  { duration: duration.quick, ease: ease.out },
                  reduced,
                )}
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                className={
                  coarse
                    ? "fixed inset-x-0 bottom-0 z-[801] flex flex-col max-h-[92dvh] bg-soft-oat rounded-t-2xl overflow-hidden shadow-2xl shadow-primary/30 focus:outline-none"
                    : "fixed left-1/2 top-1/2 z-[801] flex flex-col w-[min(560px,calc(100vw-48px))] max-h-[86dvh] -translate-x-1/2 -translate-y-1/2 bg-soft-oat rounded-xl overflow-hidden shadow-2xl shadow-primary/30 focus:outline-none"
                }
                initial={hidden}
                animate={shown}
                exit={hidden}
                transition={transitionFor(
                  coarse ? spring.panel : { duration: duration.glide, ease: ease.out },
                  reduced,
                )}
                /* The desktop panel is centred with a translate, and Framer
                   animates `y` on the same element. Letting it own the centring
                   too avoids the two fighting over the transform. */
                style={coarse ? undefined : { x: "-50%", y: "-50%" }}
              >
                {/* A grab handle, on touch only. It is the affordance that says
                    this panel belongs to the bottom edge. */}
                {coarse && (
                  <div className="pt-3 pb-1 flex justify-center shrink-0" aria-hidden="true">
                    <span className="block h-1 w-10 rounded-full bg-outline-variant" />
                  </div>
                )}

                <div className="overflow-y-auto overscroll-contain">
                  <div className="aspect-[4/3] bg-surface-container overflow-hidden">
                    <img
                      src={pan.image}
                      alt={pan.alt}
                      className="w-full h-full object-cover"
                      width={1408}
                      height={768}
                      decoding="async"
                    />
                  </div>

                  <div className="p-6 md:p-8">
                    <div className="flex justify-between items-start gap-4 mb-2">
                      <DialogPrimitive.Title className="font-display text-[28px] leading-[1.2] font-semibold text-primary">
                        {pan.name}
                      </DialogPrimitive.Title>
                      <span className="font-body text-[13px] font-semibold uppercase tracking-[0.15em] text-deep-burgundy whitespace-nowrap mt-2">
                        {pan.price} {pan.currency}
                      </span>
                    </div>

                    <p className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary mb-5">
                      {pan.serves}
                    </p>

                    <DialogPrimitive.Description className="font-body text-[16px] leading-[26px] text-on-surface-variant">
                      {pan.detail}
                    </DialogPrimitive.Description>
                  </div>
                </div>

                {/* Docked, so the action is reachable without scrolling back up
                    on a long description. */}
                <div className="shrink-0 border-t border-outline-variant/40 bg-soft-oat p-4 md:p-6 flex gap-3">
                  <a
                    href="https://wa.me/201000000000"
                    target="_blank"
                    rel="noreferrer noopener"
                    className="btn btn-lift flex-1 inline-flex items-center justify-center bg-deep-burgundy text-white font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-6 py-4 rounded-sm"
                  >
                    Order this
                  </a>
                  <DialogPrimitive.Close asChild>
                    <button
                      type="button"
                      className="btn inline-flex items-center justify-center border border-outline-variant text-primary font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-6 py-4 rounded-sm hover:bg-surface-container-low"
                    >
                      Close
                    </button>
                  </DialogPrimitive.Close>
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
