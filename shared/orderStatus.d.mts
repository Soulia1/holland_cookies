// Types for shared/orderStatus.mjs. The module is plain ESM so that the CJS
// backend can require() it; this file is what gives the two TypeScript apps a
// strict status union instead of `string`.

export type OrderStatus =
  | 'ordered'
  | 'confirmed'
  | 'baking'
  | 'in_transit'
  | 'completed'
  | 'cancelled';

export type FulfillmentType = 'delivery' | 'pickup';

/** Every value the orders collection has ever held, pre-migration. */
export type LegacyOrderStatus =
  | 'pending'
  | 'confirmed'
  | 'preparing'
  | 'ready_for_pickup'
  | 'out_for_delivery'
  | 'picked_up'
  | 'delivered'
  | 'cancelled';

export interface OrderStatusStep {
  status: OrderStatus;
  name: string;
  isCompleted: boolean;
  isCurrent: boolean;
  timestamp?: string;
}

export interface StatusTransitionResult {
  valid: boolean;
  reason?: string;
}

export declare const ORDER_STATUSES: readonly OrderStatus[];
/** The progress flow in order. Excludes `cancelled`, which sits outside it. */
export declare const STATUS_FLOW: readonly OrderStatus[];
export declare const CANCELLED: 'cancelled';
export declare const FULFILLMENT_TYPES: readonly FulfillmentType[];
export declare const LEGACY_STATUS_MAP: Record<LegacyOrderStatus, OrderStatus>;

export declare function isValidStatus(status: unknown): status is OrderStatus;
export declare function statusLabel(
  status: OrderStatus | string,
  fulfillmentType: FulfillmentType | string | undefined,
): string;
export declare function migrateStatus(status: string): OrderStatus | null;
export declare function statusIndex(status: OrderStatus | string): number;
export declare function isTerminal(status: OrderStatus | string): boolean;
export declare function allowedNextStatuses(
  currentStatus: OrderStatus | string,
  fulfillmentType?: FulfillmentType | string,
): OrderStatus[];
export declare function validateStatusTransition(
  currentStatus: OrderStatus | string,
  nextStatus: OrderStatus | string,
  fulfillmentType?: FulfillmentType | string,
): StatusTransitionResult;
export declare function statusSteps(
  status: OrderStatus | string,
  fulfillmentType?: FulfillmentType | string,
  timestamps?: Record<string, string | undefined>,
): OrderStatusStep[];
