// Types for shared/orderSearch.mjs. The module is plain ESM so the CJS backend
// can require() it; this file is what the dashboard compiles against.

/** The normalised, throwaway view of one order that matching reads. */
export interface OrderSearchIndex {
  orderId: string;
  name: string;
  phone: string;
  phoneDigits: string[];
  /** Every remaining searchable field, newline-joined. */
  text: string;
  /** createdAt as epoch ms, for ordering ties within a score tier. */
  createdAt: number;
}

export interface ParsedSearchQuery {
  text: string;
  digits: string;
  empty: boolean;
}

export declare function normalizeText(value: unknown): string;
export declare function digitsOf(value: unknown): string;
export declare function phoneDigitVariants(phone: unknown): string[];
export declare function buildOrderSearchIndex(order?: Record<string, unknown>): OrderSearchIndex;
export declare function parseSearchQuery(query: unknown): ParsedSearchQuery;
/** 0 means no match. An empty query scores every order equally. */
export declare function scoreSearchMatch(
  index: OrderSearchIndex,
  parsed: ParsedSearchQuery,
): number;
export declare function searchOrders<T>(
  orders: T[],
  query: unknown,
  indexOf?: (order: T) => OrderSearchIndex,
): T[];
export declare function payloadSearchShape(order?: Record<string, any>): Record<string, unknown>;
export interface OrderQuery {
  page?: number;
  perPage?: number;
  q?: string;
  status?: string | null;
  fulfilment?: string | null;
}
export declare function queryOrders<T extends { status?: unknown; fulfilment?: unknown }>(
  rows: readonly T[],
  query: OrderQuery,
  indexOf: (row: T) => OrderSearchIndex,
): { rows: T[]; total: number; pages: number };
