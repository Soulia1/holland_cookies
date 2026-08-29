import { CircleCheck, CircleMinus, Clock3, Store, Truck } from "lucide-react";
import { statusLabel, type FulfillmentType, type OrderStatus } from "@shared/orderStatus.mjs";

// Four semantic tones rather than one hue per status, so every surface reads as
// one system instead of a colour chart. Tone is presentation and lives here; the
// label and the transition rules come from the shared model so the dashboard
// cannot drift from what the server will actually accept.
type Tone = "is-pending" | "is-active" | "is-done" | "is-cancelled";

const TONE_ICONS: Record<Tone, typeof CircleCheck> = {
  "is-pending": Clock3,
  "is-active": Truck,
  "is-done": CircleCheck,
  "is-cancelled": CircleMinus,
};

export const STATUS_TONES: Record<OrderStatus, Tone> = {
  ordered: "is-pending",
  confirmed: "is-active",
  baking: "is-active",
  in_transit: "is-active",
  completed: "is-done",
  cancelled: "is-cancelled",
};

/** The label depends on the order's fulfilment type, so the pill cannot be
 *  rendered from the status alone — a pickup order must never read "Delivered". */
export function StatusPill({
  status,
  fulfillmentType,
}: {
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
}) {
  const tone = STATUS_TONES[status] ?? ("is-pending" as Tone);
  const Icon = TONE_ICONS[tone];
  return (
    <span className={`adm-pill ${tone}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {statusLabel(status, fulfillmentType)}
    </span>
  );
}

export function FulfillmentPill({ fulfillmentType }: { fulfillmentType: FulfillmentType }) {
  const isPickup = fulfillmentType === "pickup";
  return (
    <span className={`adm-pill ${isPickup ? "is-pickup" : "is-delivery"}`}>
      {isPickup ? <Store className="size-3.5 shrink-0" aria-hidden />
        : <Truck className="size-3.5 shrink-0" aria-hidden />}
      {isPickup ? "Pickup" : "Delivery"}
    </span>
  );
}
