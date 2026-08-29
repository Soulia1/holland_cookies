export interface DiscountableProduct {
  price?: number;
  discountEnabled?: boolean;
  discountType?: 'percent' | 'fixed';
  discountValue?: number;
}

export const DISCOUNT_TYPES: readonly ['percent', 'fixed'];
export function money(value: number): number;
export function effectivePrice(product: DiscountableProduct): number;
export function discountProblem(product: DiscountableProduct): string | null;
export function lineTotal(product: DiscountableProduct, qty: number): number;
export function hasDiscount(product: DiscountableProduct): boolean;
export function discountAmount(product: DiscountableProduct): number;
export function discountPercentOff(product: DiscountableProduct): number;
