// The detail dialog for a menu row.
//
// A deliberate port of PanDetail rather than a new idea: the two are the same
// surface for the same job — a product, its picture, what it costs, and a way
// to put it in the bag — and the site should not have two dialogs that behave
// differently. Radix supplies the focus trap, the focus return, the aria-modal
// wiring and the inert background; Framer owns entry and exit so both share the
// motion tokens. Bottom sheet on touch, centred panel on a pointer.
//
// What differs from PanDetail is the ending. That one links out to WhatsApp
// because the home page predates the cart; this one adds to the real cart, so
// opening a row and adding from it lands in the same bag as adding from the row
// itself.

import { useEffect } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import AddToCart from "@/components/AddToCart";
import type { MenuCategory, MenuItem } from "@/data/menu";
import { describeItem } from "@/data/menuCopy";
import { itemImage } from "@/data/menuImages";
import { localized, useLang } from "@/lib/i18n";
import {
  duration,
  ease,
  spring,
  transitionFor,
  travel,
  travelFor,
} from "@/lib/motion/tokens";
import { useCapability } from "@/lib/motion/useCapability";

export interface MenuSelection {
  item: MenuItem;
  category: MenuCategory;
}

export default function MenuItemDetail({
  selection,
  onClose,
}: {
  selection: MenuSelection | null;
  onClose: () => void;
}) {
  const { t, lang } = useLang();
  const { reduced, coarse } = useCapability();
  const open = selection !== null;

  // The visual half of locking the page behind the dialog; Radix does the aria
  // half. The scrollbar compensation is what stops the page underneath sliding
  // sideways as its scrollbar disappears.
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

  const hidden = coarse
    ? { y: reduced ? 0 : "100%", opacity: reduced ? 0 : 1, scale: 1 }
    : { y: travelFor(travel.panel, reduced), opacity: 0, scale: reduced ? 1 : 0.98 };
  const shown = { y: 0, opacity: 1, scale: 1 };

  const item = selection?.item;
  const category = selection?.category;
  const name = item ? localized(lang, item.name, item.nameAr) : "";
  const note = item?.note ? localized(lang, item.note, item.noteAr) : undefined;
  const photo = item ? itemImage(item.id) : undefined;

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AnimatePresence>
        {open && item && category && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-[800] bg-primary/40 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transitionFor({ duration: duration.quick, ease: ease.out }, reduced)}
              />
            </DialogPrimitive.Overlay>

            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                className={
                  coarse
                    ? "fixed inset-x-0 bottom-0 z-[801] flex flex-col max-h-[92dvh] bg-soft-oat rounded-t-2xl overflow-hidden shadow-2xl shadow-primary/30 focus:outline-none"
                    : "fixed left-1/2 top-1/2 z-[801] flex flex-col w-[min(520px,calc(100vw-48px))] max-h-[86dvh] -translate-x-1/2 -translate-y-1/2 bg-soft-oat rounded-xl overflow-hidden shadow-2xl shadow-primary/30 focus:outline-none"
                }
                initial={hidden}
                animate={shown}
                exit={hidden}
                transition={transitionFor(
                  coarse ? spring.panel : { duration: duration.glide, ease: ease.out },
                  reduced,
                )}
                style={coarse ? undefined : { x: "-50%", y: "-50%" }}
              >
                {coarse && (
                  <div className="pt-3 pb-1 flex justify-center shrink-0" aria-hidden="true">
                    <span className="block h-1 w-10 rounded-full bg-outline-variant" />
                  </div>
                )}

                <div className="overflow-y-auto overscroll-contain">
                  {/* The picture, or the same branded tile the row uses. An item
                      waiting for its photograph keeps the dialog's proportions
                      rather than opening a panel with the top third missing. */}
                  {/* Square, and `object-contain` rather than `object-cover`.
                      The sources are square, so a 4:3 box cropped the top and
                      bottom off every one of them — on a cross-section like the
                      cut cookies that meant slicing away the filling, which is
                      the entire subject of the photograph. Contain also keeps a
                      source that is *not* square whole rather than trimming it,
                      centred against the surface colour. */}
                  {/* Square where there is room, but never so tall that it
                      pushes the name and the price off the bottom of a short
                      window — which a full-width square does on a laptop, and
                      it is the description that disappears, not the picture.
                      Capped in viewport units so the panel keeps the whole
                      image *and* its text on screen at any height; contain then
                      letterboxes sideways instead of cropping. */}
                  <div className="h-[min(42dvh,320px)] w-full bg-surface-container overflow-hidden flex items-center justify-center">
                    {photo ? (
                      <img
                        src={photo}
                        alt=""
                        className="max-w-full max-h-full w-auto h-full object-contain"
                        width={320}
                        height={320}
                        decoding="async"
                      />
                    ) : (
                      <div className="w-full h-full grid place-items-center bg-[rgb(93_16_29_/_0.055)]">
                        <svg
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                          focusable="false"
                          className="w-12 h-12 fill-none stroke-deep-burgundy opacity-30"
                          strokeWidth={1.5}
                        >
                          <circle cx="12" cy="12" r="9" />
                          <circle cx="9" cy="9.5" r="1.4" className="fill-deep-burgundy stroke-none" />
                          <circle cx="15" cy="11" r="1.1" className="fill-deep-burgundy stroke-none" />
                          <circle cx="11" cy="15" r="1.2" className="fill-deep-burgundy stroke-none" />
                        </svg>
                      </div>
                    )}
                  </div>

                  <div className="p-6 md:p-7">
                    <div className="flex justify-between items-start gap-4 mb-1">
                      <DialogPrimitive.Title className="font-display text-[26px] leading-[1.2] font-semibold text-primary">
                        {name}
                      </DialogPrimitive.Title>
                      <span className="font-body text-[14px] font-semibold text-deep-burgundy whitespace-nowrap mt-2 tabular-nums">
                        {t.price(item.price)}
                      </span>
                    </div>

                    {/* The category, and the packaging where the sheet prints
                        one. Both are facts off the sheet rather than copy. */}
                    <p className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary mb-4">
                      {localized(lang, category.name, category.nameAr)}
                      {note ? <span> · {note}</span> : null}
                    </p>

                    <DialogPrimitive.Description className="font-body text-[15px] leading-[25px] text-on-surface-variant">
                      {describeItem(item, category)}
                    </DialogPrimitive.Description>
                  </div>
                </div>

                <div className="shrink-0 border-t border-outline-variant/40 bg-soft-oat p-4 md:p-5 flex gap-3 items-center">
                  <AddToCart
                    className="menu-detail-add"
                    label={t.addToCart}
                    item={{
                      productId: item.id,
                      name,
                      price: item.price,
                      ...(note ? { note } : {}),
                    }}
                  />
                  <DialogPrimitive.Close asChild>
                    <button
                      type="button"
                      className="btn inline-flex items-center justify-center border border-outline-variant text-primary font-body text-[12px] font-semibold uppercase tracking-[0.15em] px-6 py-3.5 rounded-sm hover:bg-surface-container-low"
                    >
                      {t.menuDetailClose}
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
