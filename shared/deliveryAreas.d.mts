export interface DeliveryArea {
  id: string;
  name: string;
  nameAr?: string;
  /** The governorate this area is in, which the checkout select groups by. */
  city?: string;
  cityAr?: string;
}

export interface DeliveryAreaGroup {
  city: string;
  cityAr: string;
  areas: DeliveryArea[];
}

export const CAIRO: string;
export const GIZA: string;
export const CAIRO_AREAS: DeliveryArea[];
export const GIZA_AREAS: DeliveryArea[];
export const DEFAULT_AREAS: DeliveryArea[];
export function areasByCity(areas: readonly DeliveryArea[] | null | undefined): DeliveryAreaGroup[];
