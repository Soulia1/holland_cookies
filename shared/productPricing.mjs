/**
 * Product pricing, under the name the dashboard imports it by.
 *
 * The dashboard was ported from Scooby, where this arithmetic lives in
 * `shared/productPricing.mjs`. Holland's copy lives in `shared/pricing.mjs` and
 * is imported by the backend and the storefront under that name. Rather than
 * keep two implementations — which is precisely the failure `pricing.mjs`
 * exists to prevent, and which would make every discounted order fail the
 * moment the two rounded differently — this file is a re-export.
 *
 * If you are looking for the arithmetic, it is in `pricing.mjs`.
 */

export {
  money,
  effectivePrice,
  discountProblem,
  lineTotal,
  unitPrice,
  selectionProblem,
  lineSignature,
} from './pricing.mjs';

import { effectivePrice, money, discountPercent, isDiscounted } from './pricing.mjs';

/** The discount types the editor offers. */
export const DISCOUNT_TYPES = ['percent', 'fixed'];

/** Whether this product is currently selling below its regular price. */
export function hasDiscount(product) {
  return isDiscounted(product);
}

/** How many pounds are coming off. */
export function discountAmount(product) {
  return money((Number(product?.price) || 0) - effectivePrice(product));
}

/** Whole percent off, for the badge. */
export function discountPercentOff(product) {
  return discountPercent(product);
}
