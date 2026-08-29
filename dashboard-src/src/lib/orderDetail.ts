// Derivations for the single-order view. Kept out of the component so the
// arithmetic and the history merge are testable without a DOM.

import { statusLabel, type FulfillmentType } from "@shared/orderStatus.mjs";
import type { OrderDetail, StatusHistoryEntry } from "./api";

export interface MoneyLine {
  label: string;
  /** Signed: a discount is negative, so the lines above the total add up to it. */
  amount: number;
  isTotal?: boolean;
}

export interface TimelineEntry {
  status: string;
  label: string;
  at: string;
  note: string;
  /** Which credential made the change. Admin access is one shared identity, so
   *  this is the most specific attribution the system can honestly offer. */
  actor: string;
}

export function fulfillmentOf(order: { fulfillmentType?: FulfillmentType }): FulfillmentType {
  return order.fulfillmentType === "pickup" ? "pickup" : "delivery";
}

const ACTORS: Record<string, string> = {
  "admin-session": "Dashboard session",
  "admin-key": "Admin key (script)",
  "shared-admin": "Shared admin",
};

function actorName(changedBy: string): string {
  return ACTORS[changedBy] || changedBy || "Unknown";
}

function history(order: OrderDetail): StatusHistoryEntry[] {
  return Array.isArray(order.statusHistory) ? order.statusHistory : [];
}

/**
 * The money on one order, as lines that sum to the charged total.
 *
 * Orders written before subtotal/discount existed carry only `total`, so the
 * subtotal is back-derived rather than rendered as a blank — a breakdown that
 * does not reconcile is worse than no breakdown.
 */
export function moneyBreakdown(order: OrderDetail): MoneyLine[] {
  const total = Number(order.total) || 0;
  const deliveryFee = Number(order.deliveryFee) || 0;
  const discount = Number(order.discount) || 0;
  const subtotal = typeof order.subtotal === "number"
    ? order.subtotal
    : total + discount - deliveryFee;

  const lines: MoneyLine[] = [{ label: "Subtotal", amount: subtotal }];
  if (discount > 0) {
    lines.push({
      label: order.promoCode ? `Discount (${order.promoCode})` : "Discount",
      amount: -discount,
    });
  }
  // A pickup order has no delivery leg at all, so the row would be noise. On a
  // delivery order a zero fee is real information — free delivery — and is kept.
  if (fulfillmentOf(order) === "delivery") {
    lines.push({ label: "Delivery fee", amount: deliveryFee });
  }
  lines.push({ label: "Total", amount: total, isTotal: true });
  return lines;
}

/**
 * status -> when the order first reached it, for the shared stepper.
 *
 * `ordered` comes from createdAt: an order is placed at that status, so no
 * history row exists for it. Later duplicates of a status are ignored — the
 * stepper wants when a step was reached, not when it was last touched.
 */
export function statusTimestamps(order: OrderDetail): Record<string, string> {
  const stamps: Record<string, string> = {};
  if (order.createdAt) stamps.ordered = order.createdAt;
  for (const row of history(order)) {
    if (row.newStatus && !stamps[row.newStatus]) stamps[row.newStatus] = row.createdAt;
  }
  return stamps;
}

/**
 * Everything that has happened to the order, oldest first.
 *
 * Always opens with the customer placing it, so an order nobody has touched
 * still reads as a history rather than an empty panel.
 */
export function orderTimeline(order: OrderDetail): TimelineEntry[] {
  const type = fulfillmentOf(order);
  const entries: TimelineEntry[] = [
    {
      status: "ordered",
      label: statusLabel("ordered", type),
      at: order.createdAt,
      note: "",
      actor: "Customer",
    },
  ];
  for (const row of history(order)) {
    entries.push({
      status: row.newStatus,
      label: statusLabel(row.newStatus, type),
      at: row.createdAt,
      note: row.note || "",
      actor: actorName(row.changedBy),
    });
  }
  return entries;
}
