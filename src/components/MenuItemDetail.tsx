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

import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, motion } from "framer-motion";
import AddToCart from "@/components/AddToCart";
import { flavorVariants, type MenuCategory, type MenuItem } from "@/data/menu";
import { selectionProblem, unitPrice } from "../../shared/productPricing.mjs";
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

  // Which flavor the customer has picked, for items that name several
  // flavors as one printed line (see `flavorChoices` on `MenuItem`) rather
  // than as separate items. Keyed off the item id rather than reset in an
  // effect, so switching straight from one row's dialog to another's — the
  // trigger stays mounted, `selection` just changes — can never leak the
  // previous item's pick into this one.
  const [flavorPick, setFlavorPick] = useState<{ itemId: string; flavor: string } | null>(null);
  // A choice bundle's picks, keyed `group:productId`, and keyed off the item for
  // the same reason as the flavor above.
  const [picks, setPicks] = useState<{ itemId: string; counts: Record<string, number> } | null>(null);

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
  const photo = item ? (item.image ?? itemImage(item.id)) : undefined;

  const choices = item?.flavorChoices;
  const chosenFlavor =
    choices && flavorPick?.itemId === item?.id ? flavorPick.flavor : null;

  // The printed line names several flavors before an em dash and the shared
  // filling after it — "Vanilla, Red Velvet or Chocolate — Nutella filling" —
  // so the cart line for a chosen flavor is built from that same filling text
  // rather than a second copy of it hand-typed here.
  const cartName =
    choices && chosenFlavor
      ? `${chosenFlavor}, ${name.split("—")[1]?.trim() ?? name}`
      : name;
  const cartProductId =
    item && choices && chosenFlavor
      ? flavorVariants(item).find((variant) => variant.flavor === chosenFlavor)?.id
      : item?.id;

  const bundle = item?.bundle;
  const counts = bundle?.type === "choice" && picks && picks.itemId === item?.id ? picks.counts : {};
  const selections = Object.entries(counts)
    .filter(([, quantity]) => quantity > 0)
    .map(([key, quantity]) => {
      const split = key.indexOf(":");
      return { group: Number(key.slice(0, split)), productId: key.slice(split + 1), quantity };
    });
  const pricing = item && bundle
    ? { price: item.price, isBundle: true, bundleType: bundle.type, groups: bundle.groups }
    : null;
  const shownPrice = item ? (pricing ? unitPrice(pricing, selections) : item.price) : 0;
  const choicesIncomplete = pricing && bundle?.type === "choice"
    ? selectionProblem(pricing, selections) !== null
    : false;
  const cartSelections = selections.map((pick) => {
    const option = bundle?.groups[pick.group]?.options.find((entry) => entry.productId === pick.productId);
    return { ...pick, name: option ? localized(lang, option.name, option.nameAr) : pick.productId };
  });
  const setCount = (group: number, productId: string, next: number) => {
    if (!item) return;
    setPicks((current) => ({
      itemId: item.id,
      counts: {
        ...(current?.itemId === item.id ? current.counts : {}),
        [`${group}:${productId}`]: Math.max(0, next),
      },
    }));
  };

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
                        {t.price(shownPrice)}
                      </span>
                    </div>

                    {/* The category, and the packaging where the sheet prints
                        one. Both are facts off the sheet rather than copy. */}
                    <p className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary mb-4">
                      {localized(lang, category.name, category.nameAr)}
                      {note ? <span> · {note}</span> : null}
                    </p>

                    <DialogPrimitive.Description className="font-body text-[15px] leading-[25px] text-on-surface-variant">
                      {/* What the admin wrote in the dashboard, when there is
                          something; otherwise the sentence built from the sheet. */}
                      {item.description
                        ? localized(lang, item.description, item.descriptionAr)
                        : describeItem(item, category)}
                    </DialogPrimitive.Description>

                    {/* A choice, not a bare list of flavors, so the cart line
                        it produces names one real product instead of the
                        printed shorthand for three. */}
                    {choices && (
                      <div className="mt-5" role="radiogroup" aria-label={t.menuDetailChooseFlavor}>
                        <p className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary mb-2">
                          {t.menuDetailChooseFlavor}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {choices.map((flavor) => {
                            const picked = chosenFlavor === flavor;
                            return (
                              <button
                                key={flavor}
                                type="button"
                                role="radio"
                                aria-checked={picked}
                                className={`btn font-body text-[13px] font-semibold px-4 py-2 rounded-full border transition-colors ${
                                  picked
                                    ? "bg-primary text-on-primary border-primary"
                                    : "border-outline-variant text-primary hover:bg-surface-container-low"
                                }`}
                                onClick={() => setFlavorPick({ itemId: item.id, flavor })}
                              >
                                {flavor}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {bundle?.type === "fixed" && bundle.components.length > 0 && (
                      <div className="mt-5">
                        <p className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary mb-2">
                          {t.bundleIncludes}
                        </p>
                        <ul className="font-body text-[14px] text-on-surface-variant space-y-1">
                          {bundle.components.map((component) => (
                            <li key={component.productId}>
                              {component.quantity}× {localized(lang, component.name, component.nameAr)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {bundle?.type === "choice" && bundle.groups.map((group, groupIndex) => {
                      const taken = group.options.reduce(
                        (sum, option) => sum + (counts[`${groupIndex}:${option.productId}`] ?? 0), 0,
                      );
                      const label = localized(lang, group.label, group.labelAr);
                      return (
                        <div key={groupIndex} className="mt-5" role="group" aria-label={label}>
                          <p className="font-body text-[12px] font-semibold uppercase tracking-[0.15em] text-secondary mb-2 flex justify-between gap-3">
                            <span>{label}</span>
                            <span className="tabular-nums">{t.bundlePicked(taken, group.choose)}</span>
                          </p>
                          <ul className="space-y-2">
                            {group.options.map((option) => {
                              const count = counts[`${groupIndex}:${option.productId}`] ?? 0;
                              const optionName = localized(lang, option.name, option.nameAr);
                              const canAdd = option.available
                                && taken < group.choose
                                && (group.allowRepeats || count === 0);
                              return (
                                <li key={option.productId}
                                  className="flex items-center justify-between gap-3 rounded-sm border border-outline-variant px-3 py-2">
                                  <span className="font-body text-[14px] text-primary">
                                    {optionName}
                                    {option.surcharge > 0 && (
                                      <span className="text-secondary"> +{t.price(option.surcharge)}</span>
                                    )}
                                    {!option.available && <span className="text-secondary"> · {t.soldOut}</span>}
                                  </span>
                                  <span className="flex items-center gap-2 shrink-0">
                                    <button type="button"
                                      className="btn w-8 h-8 rounded-full border border-outline-variant text-primary disabled:opacity-30"
                                      aria-label={t.cartDecrease(optionName)}
                                      disabled={count === 0}
                                      onClick={() => setCount(groupIndex, option.productId, count - 1)}>
                                      −
                                    </button>
                                    <span className="tabular-nums w-4 text-center font-body text-[14px]">{count}</span>
                                    <button type="button"
                                      className="btn w-8 h-8 rounded-full border border-outline-variant text-primary disabled:opacity-30"
                                      aria-label={t.cartIncrease(optionName)}
                                      disabled={!canAdd}
                                      onClick={() => setCount(groupIndex, option.productId, count + 1)}>
                                      +
                                    </button>
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="shrink-0 border-t border-outline-variant/40 bg-soft-oat p-4 md:p-5 flex gap-3 items-center">
                  {item.soldOut ? (
                    <button
                      type="button"
                      className="add-btn btn menu-detail-add opacity-50 cursor-not-allowed"
                      disabled
                    >
                      <span className="add-btn-label">{t.soldOut}</span>
                    </button>
                  ) : choicesIncomplete ? (
                    <button
                      type="button"
                      className="add-btn btn menu-detail-add opacity-50 cursor-not-allowed"
                      disabled
                    >
                      <span className="add-btn-label">{t.bundleMakeChoices}</span>
                    </button>
                  ) : choices && !chosenFlavor ? (
                    // Blocked until a flavor is picked, rather than adding
                    // the printed shorthand itself to the cart — the shop
                    // cannot bake "Vanilla, Red Velvet or Chocolate".
                    <button
                      type="button"
                      className="add-btn btn menu-detail-add opacity-50 cursor-not-allowed"
                      disabled
                    >
                      <span className="add-btn-label">{t.menuDetailChooseFlavor}</span>
                    </button>
                  ) : (
                    <AddToCart
                      key={cartProductId}
                      className="menu-detail-add"
                      label={t.addToCart}
                      item={{
                        productId: cartProductId!,
                        name: cartName,
                        price: shownPrice,
                        ...(note ? { note } : {}),
                        ...(photo ? { image: photo } : {}),
                        ...(cartSelections.length ? { selections: cartSelections } : {}),
                      }}
                    />
                  )}
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
