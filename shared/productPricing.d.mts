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
export interface Selection {
  group: number;
  productId: string;
  quantity: number;
}

/** An option the customer picks one of, and what picking it adds to the price. */
export interface ProductChoice {
  name: string;
  nameAr?: string;
  /** Added to the product's selling price when this option is picked. */
  priceDelta?: number;
}

export interface BundleProduct extends DiscountableProduct {
  isBundle?: boolean;
  bundleType?: 'fixed' | 'choice';
  choices?: readonly ProductChoice[];
  groups?: readonly {
    label: string;
    choose: number;
    allowRepeats?: boolean;
    options: readonly { productId: string; surcharge?: number }[];
  }[];
}

export function lineTotal(
  product: BundleProduct, qty: number, selections?: readonly Selection[], choice?: string,
): number;
export function unitPrice(
  product: BundleProduct, selections?: readonly Selection[], choice?: string,
): number;
export function choiceSurcharge(product: { choices?: readonly ProductChoice[] }, choice?: string): number;
export function selectionProblem(product: BundleProduct, selections?: readonly Selection[]): string | null;
export function choiceProblem(product: { choices?: readonly { name: string }[] }, choice?: string): string | null;
export function lineSignature(item: { productId: string; choice?: string; selections?: readonly Selection[] }): string;
export function hasDiscount(product: DiscountableProduct): boolean;
export function discountAmount(product: DiscountableProduct): number;
export function discountPercentOff(product: DiscountableProduct): number;

/** Delivery for a subtotal under the shop settings: 0 for pickup, and free from the threshold up. */
export declare function deliveryFee(
  subtotal: number,
  settings: { deliveryFee?: number; freeDeliveryOver?: number } | null | undefined,
  fulfilment: string,
): number;
