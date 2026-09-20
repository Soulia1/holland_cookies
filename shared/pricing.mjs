/**
 * Pricing. One implementation, imported by everything that touches money.
 *
 * The storefront cart, the checkout summary, the dashboard product editor and
 * the backend order transaction all import this file. That is not tidiness, it
 * is the only arrangement that works, and Scooby learned it the expensive way:
 *
 *   Checkout sends the subtotal the customer was shown, and the server refuses
 *   the order if its own arithmetic disagrees. So a storefront that rounded a
 *   discount even slightly differently from the server would not display a
 *   wrong price — it would make *every discounted order fail at the last step*,
 *   for reasons nobody could see from either side.
 *
 * Hence: no second copy of this arithmetic anywhere, in any language.
 *
 * ESM with a `.mjs` extension so the CommonJS backend can `await import()` it
 * and the browser bundler can treat it as an ordinary module. Deliberately no
 * dependencies and no I/O — it is pure arithmetic and can be tested as such.
 */

/**
 * Round to piastres.
 *
 * Every figure derived from a discounted line goes through this, so the same
 * rounding is applied at every step rather than float dust accumulating into a
 * stored total that is a hundredth of a pound away from the one displayed.
 */
export function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * The price a product actually sells for right now.
 *
 * The regular price is never overwritten and no sale price is ever stored —
 * the discount is three fields and the sale price is always derived. Turning a
 * discount off therefore restores the original exactly, with nothing to clean
 * up and no chance of a stale "was" price outliving the promotion that set it.
 *
 * A malformed discount sells at full price rather than blocking the sale. That
 * asymmetry is deliberate: refusing to sell is a worse failure than failing to
 * apply a discount, and the second is visible to whoever configured it.
 */
export function effectivePrice(product) {
  const base = Number(product?.price);
  if (!Number.isFinite(base) || base < 0) return 0;
  if (!product?.discountEnabled) return money(base);

  const value = Number(product.discountValue);
  if (!Number.isFinite(value) || value <= 0) return money(base);

  if (product.discountType === "percent") {
    if (value >= 100) return money(base);
    return money(base * (1 - value / 100));
  }
  if (product.discountType === "fixed") {
    // A fixed discount at or above the price would sell at zero or less. The
    // route-level validation in the dashboard refuses to save that; this is the
    // second line of defence for a document that predates the validation.
    if (value >= base) return money(base);
    return money(base - value);
  }
  return money(base);
}

/** Whether a product is currently selling below its regular price. */
export function isDiscounted(product) {
  return effectivePrice(product) < money(Number(product?.price) || 0);
}

/** Whole percent off, for the badge on a card. */
export function discountPercent(product) {
  const base = money(Number(product?.price) || 0);
  if (base <= 0) return 0;
  const now = effectivePrice(product);
  if (now >= base) return 0;
  return Math.round(((base - now) / base) * 100);
}

/**
 * Why a product's discount configuration is invalid, or null if it is fine.
 *
 * Takes the *merged* document — the patch laid over what is already stored —
 * because that is the only view in which the real trap is visible. Raising the
 * discount on Monday and cutting the price on Tuesday each pass on their own,
 * and together they price the product at zero.
 */
export function discountProblem(product) {
  if (!product?.discountEnabled) return null;
  const base = Number(product.price);
  const value = Number(product.discountValue);
  if (!Number.isFinite(value) || value <= 0) {
    return "A discount must be greater than zero.";
  }
  if (product.discountType === "percent") {
    return value >= 100 ? "A percentage discount must be below 100%." : null;
  }
  if (product.discountType === "fixed") {
    if (!Number.isFinite(base)) return "A fixed discount needs a price to subtract from.";
    return value >= base ? "A fixed discount must be less than the price." : null;
  }
  return "Choose a percentage or a fixed discount.";
}

/**
 * What the option named on a line adds to its price, in pounds.
 *
 * An option's extra is stored on the product as `priceDelta`, exactly like a
 * choice bundle's `surcharge`, and for the same reason: the product keeps one
 * price and each option says what it adds to it. Storing an absolute price per
 * option instead would mean a repricing had to be repeated on every option, and
 * the one that was missed would keep selling at the old figure.
 *
 * Read from the stored product only. A cart that names an option that no longer
 * exists adds nothing here — `choiceProblem` is what refuses that order, and it
 * is not this function's job to guess a price for a choice that is gone.
 */
export function choiceSurcharge(product, choice) {
  const choices = Array.isArray(product?.choices) ? product.choices : [];
  if (!choices.length || typeof choice !== "string" || !choice) return 0;
  const picked = choices.find((entry) => entry?.name === choice);
  const extra = Number(picked?.priceDelta);
  return Number.isFinite(extra) && extra > 0 ? money(extra) : 0;
}

/**
 * What one unit of a line costs: the selling price, plus what the option picked
 * adds, plus the surcharge of every option picked when the product is a choice
 * bundle.
 *
 * Only `group`, `productId` and `quantity` are read from a selection, and only
 * the option's name from `choice`. Every figure of money comes from the stored
 * product, never from the cart.
 *
 * A product can have options or be a bundle, never both — the catalogue route
 * refuses the combination — so the two extras below cannot both be non-zero.
 */
export function unitPrice(product, selections, choice) {
  const base = effectivePrice(product);
  let extra = choiceSurcharge(product, choice);
  if (product?.isBundle && product.bundleType === "choice" && Array.isArray(selections)) {
    for (const pick of selections) {
      const option = product.groups?.[pick?.group]?.options?.find((o) => o.productId === pick.productId);
      if (option) extra += (Number(option.surcharge) || 0) * Math.max(0, Math.floor(Number(pick.quantity) || 0));
    }
  }
  return extra ? money(base + extra) : base;
}

/**
 * Why these choices are not a valid way to order this product, or null.
 *
 * A product that is not a choice bundle takes no choices. A choice bundle needs
 * exactly `choose` picks from each group, from that group's own options.
 */
export function selectionProblem(product, selections) {
  const picks = Array.isArray(selections) ? selections : [];
  if (!product?.isBundle || product.bundleType !== "choice") {
    return picks.length ? "This item has no choices to make." : null;
  }
  const groups = Array.isArray(product.groups) ? product.groups : [];
  for (const pick of picks) {
    const group = groups[pick?.group];
    if (!group || !group.options?.some((o) => o.productId === pick.productId)) {
      return "One of your choices is no longer offered.";
    }
    if (!Number.isInteger(pick.quantity) || pick.quantity < 1) {
      return "Choose a whole number of each option.";
    }
  }
  for (const [index, group] of groups.entries()) {
    const mine = picks.filter((pick) => pick.group === index);
    if (new Set(mine.map((pick) => pick.productId)).size !== mine.length) {
      return `“${group.label}” lists the same choice twice.`;
    }
    if (!group.allowRepeats && mine.some((pick) => pick.quantity > 1)) {
      return `“${group.label}” cannot have the same one twice.`;
    }
    const count = mine.reduce((sum, pick) => sum + pick.quantity, 0);
    if (count !== group.choose) return `Choose ${group.choose} for “${group.label}”.`;
  }
  return null;
}

/**
 * Why this option is not a valid way to order this product, or null.
 *
 * A product with options needs exactly one of them, named as stored; a product
 * without options takes none.
 */
export function choiceProblem(product, choice) {
  const choices = Array.isArray(product?.choices) ? product.choices : [];
  const picked = typeof choice === "string" ? choice : "";
  if (!choices.length) return picked ? "This item has no options to choose from." : null;
  if (!picked) return "Choose an option for this item.";
  return choices.some((entry) => entry?.name === picked) ? null : "That option is no longer offered.";
}

/**
 * A line's identity: the product, the option picked when it has options, and
 * for a bundle exactly what was chosen.
 */
export function lineSignature(item) {
  const picks = Array.isArray(item?.selections) ? item.selections : [];
  const choice = typeof item?.choice === "string" ? item.choice : "";
  const product = choice ? `${item?.productId ?? ""}#${choice}` : String(item?.productId ?? "");
  if (!picks.length) return product;
  const parts = picks.map((pick) => `${pick.group}:${pick.productId}:${pick.quantity}`).sort();
  return `${product}|${parts.join(",")}`;
}

/** One cart line's total, at the price the product sells for now. */
export function lineTotal(product, qty, selections, choice) {
  const n = Math.max(0, Math.floor(Number(qty) || 0));
  return money(unitPrice(product, selections, choice) * n);
}

/**
 * Sum of the lines, before delivery and before any order-level promotion.
 *
 * `items` are cart lines carrying `productId` and `qty`; `catalogue` is a Map
 * from id to the stored product. Nothing is read from the cart except identity
 * and quantity — see the note in cart-core.ts about why the money a browser
 * sends is presentational only.
 */
export function subtotalOf(items, catalogue) {
  let total = 0;
  for (const item of items) {
    const product = catalogue.get(item.productId);
    if (!product) continue;
    total += lineTotal(product, item.qty, item.selections, item.choice);
  }
  return money(total);
}

/**
 * Delivery, from the settings document.
 *
 * A threshold of 0 means "never free"; a null or absent fee means pickup only.
 */
export function deliveryFee(subtotal, settings, fulfilment) {
  if (fulfilment === "pickup") return 0;
  const fee = Number(settings?.deliveryFee);
  if (!Number.isFinite(fee) || fee <= 0) return 0;
  const threshold = Number(settings?.freeDeliveryOver);
  if (Number.isFinite(threshold) && threshold > 0 && subtotal >= threshold) return 0;
  return money(fee);
}

/**
 * The whole order, priced.
 *
 * The single place the final number is decided. Returned as its parts as well
 * as the total, so the confirmation email, the dashboard and the customer's
 * receipt all break the figure down the same way.
 */
export function priceOrder({ items, catalogue, settings, fulfilment, promoDiscount = 0 }) {
  const subtotal = subtotalOf(items, catalogue);
  // Clamped so a promotion can never make an order negative, whatever is in the
  // promo document.
  const discount = money(Math.min(Math.max(0, Number(promoDiscount) || 0), subtotal));
  const delivery = deliveryFee(subtotal, settings, fulfilment);
  return {
    subtotal,
    discount,
    delivery,
    total: money(subtotal - discount + delivery),
  };
}
