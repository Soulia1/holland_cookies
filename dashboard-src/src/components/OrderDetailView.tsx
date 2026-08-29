import { Check, Loader2, MailCheck, MailX } from "lucide-react";
import { type OrderDetail, type OrderStatus } from "@/lib/api";
import { deliveryTimeSlotLabel, formatDate, formatDeliveryDate, formatEGP } from "@/lib/format";
import { fulfillmentOf, moneyBreakdown, orderTimeline, statusTimestamps } from "@/lib/orderDetail";
import { allowedNextStatuses, statusLabel, statusSteps } from "@shared/orderStatus.mjs";

/**
 * Everything known about one order.
 *
 * Rendered identically by the /orders/:id page and by the popup the orders list
 * opens, because "the exact details" must not depend on how you got to them.
 * Only the frame around it differs: the page owns a heading and a back link,
 * the dialog owns a title bar and a scrolling body.
 */

function Section({
  title, note, children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <h2 className="adm-section-title">{title}</h2>
        {note && <span className="adm-section-note">{note}</span>}
      </div>
      <div className="pt-4">{children}</div>
    </section>
  );
}

/** A labelled value. Long values (addresses, emails) wrap rather than truncate —
 *  a half-shown address is worse than a tall row. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm break-words">{value || <span className="adm-muted">—</span>}</dd>
    </div>
  );
}

const PAYMENT_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  pending: "Pending",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
  partially_refunded: "Partially refunded",
};

export default function OrderDetailView({
  order, note, onNoteChange, busy, onMove, noteFieldId = "status-note",
}: {
  order: OrderDetail;
  note: string;
  onNoteChange: (note: string) => void;
  /** The status being applied, or "" when idle. */
  busy: OrderStatus | "";
  onMove: (next: OrderStatus) => void;
  /** Distinct per instance — a page and a popup must not share an input id. */
  noteFieldId?: string;
}) {
  const type = fulfillmentOf(order);
  const isPickup = type === "pickup";
  const next = allowedNextStatuses(order.status, type);
  const steps = statusSteps(order.status, type, statusTimestamps(order));
  const lines = moneyBreakdown(order);
  const timeline = orderTimeline(order);
  const email = order.confirmationEmail;

  return (
    <>
      {/* Progress and the only moves the server will accept from here. */}
      <Section
        title="Fulfilment progress"
        note={next.length ? "One step forward, or cancel" : "This order is finished"}
      >
        {steps.length > 0 ? (
          <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-5">
            {steps.map((step) => (
              <li
                key={step.status}
                className={`bg-card p-3 ${step.isCurrent ? "bg-muted" : ""}`}
                aria-current={step.isCurrent ? "step" : undefined}
              >
                <span className="flex items-center gap-1.5 text-[12px] font-medium">
                  {step.isCompleted ? (
                    <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                  ) : (
                    <span
                      aria-hidden
                      className={`size-1.5 shrink-0 rounded-full ${
                        step.isCurrent ? "bg-foreground" : "bg-border"
                      }`}
                    />
                  )}
                  <span className={step.isCompleted || step.isCurrent ? "" : "text-muted-foreground"}>
                    {step.name}
                  </span>
                </span>
                <span className="adm-muted mt-1 block text-[11.5px]">
                  {step.timestamp ? formatDate(step.timestamp) : "—"}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          // A cancelled order gets a distinct state rather than a stepper with
          // a gap in it — that is what statusSteps returning [] means.
          <p className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
            This order was cancelled. Its history is below.
          </p>
        )}

        {next.length > 0 && (
          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <div className="min-w-[220px] flex-1">
              <label className="adm-label" htmlFor={noteFieldId}>
                Note (optional — saved on the history row)
              </label>
              <input
                id={noteFieldId}
                className="adm-input"
                value={note}
                maxLength={500}
                onChange={(e) => onNoteChange(e.target.value)}
                placeholder="Why this changed…"
              />
            </div>
            {next.map((status) => (
              <button
                key={status}
                type="button"
                className={`adm-btn ${status === "cancelled" ? "adm-btn-ghost" : ""}`}
                onClick={() => onMove(status)}
                disabled={busy !== ""}
              >
                {busy === status && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Mark as {statusLabel(status, type).toLowerCase()}
              </button>
            ))}
          </div>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Customer">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name" value={order.name} />
            {/* Unmasked here and only here: acting on an order needs the real
                number, while a glance at the list does not. */}
            <Field
              label="Phone"
              value={
                order.phone ? (
                  <a className="hover:underline" href={`tel:${order.phone}`}>{order.phone}</a>
                ) : null
              }
            />
            <Field
              label="Email"
              value={
                order.email ? (
                  <a className="hover:underline" href={`mailto:${order.email}`}>{order.email}</a>
                ) : null
              }
            />
            <Field
              label="Account"
              value={order.userId ? "Signed-in customer" : "Guest checkout"}
            />
          </dl>
        </Section>

        <Section title={isPickup ? "Pickup" : "Delivery"}>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Type" value={isPickup ? "Pickup" : "Delivery"} />
            <Field
              label={isPickup ? "Ready on" : "Delivery date"}
              value={formatDeliveryDate(order.fulfillmentDate ?? order.deliveryDate)}
            />
            {!isPickup && <Field label="Area" value={order.area} />}
            {!isPickup && <Field label="Address" value={order.address} />}
            {!isPickup && (
              <Field label="Time slot" value={deliveryTimeSlotLabel(order.deliveryTimeSlot)} />
            )}
            <Field label="Payment method" value={order.paymentMethod} />
            <Field
              label="Payment status"
              value={PAYMENT_LABELS[order.paymentStatus ?? "unpaid"] ?? order.paymentStatus}
            />
          </dl>
        </Section>
      </div>

      <Section title="Items" note={`${order.items?.length ?? 0} line(s)`}>
        <div className="overflow-x-auto">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Qty</th>
                <th className="num">Unit</th>
                <th className="num">Line total</th>
              </tr>
            </thead>
            <tbody>
              {(order.items ?? []).map((item, index) => {
                // Both bundle shapes are read here. A choice bundle carries the
                // customer's picks; a fixed bundle carries the admin-defined
                // contents. Either way the kitchen needs the breakdown, not the
                // bundle's marketing name.
                const parts = (item.selections ?? []).map((s) => ({
                  key: s.productId,
                  name: s.name,
                  perBundle: s.quantity,
                  total: s.quantity * item.qty,
                }));
                const fixed = (item.components ?? []).map((c) => ({
                  key: c.productId,
                  name: c.name,
                  perBundle: c.quantityPerBundle,
                  total: c.totalQuantity,
                }));
                const contents = parts.length ? parts : fixed;
                return (
                  <tr key={`${item.name}-${index}`}>
                    <td>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {item.emoji ? `${item.emoji} ` : ""}
                          {item.name}
                        </span>
                        {contents.length > 0 && (
                          <span className="adm-pill is-pickup">Bundle</span>
                        )}
                      </div>
                      {contents.length > 0 && (
                        <ul className="mt-2 space-y-1 border-s-2 border-border ps-3 text-[12.5px]">
                          {contents.map((c) => (
                            <li key={c.key} className="flex flex-wrap items-baseline gap-x-2">
                              <span className="font-medium tabular-nums">{c.perBundle}×</span>
                              <span>{c.name}</span>
                              {/* Only worth saying when the two differ — on a
                                  single bundle it is the same number twice. */}
                              {item.qty > 1 && (
                                <span className="adm-muted tabular-nums">
                                  ({c.total} to bake)
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="num">{item.qty}</td>
                    <td className="num">
                      {/* What was actually charged, with the regular price shown
                          struck through when the line was sold on discount. */}
                      {item.regularPrice && item.regularPrice > item.price ? (
                        <span className="whitespace-nowrap">
                          <span className="adm-muted line-through">{formatEGP(item.regularPrice)}</span>{" "}
                          {formatEGP(item.price)}
                        </span>
                      ) : (
                        formatEGP(item.price)
                      )}
                    </td>
                    <td className="num font-medium">{formatEGP(item.price * item.qty)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!order.items?.length && <p className="adm-empty">No items recorded on this order.</p>}
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="Money" note="What the customer was charged">
          <dl className="space-y-2">
            {lines.map((line) => (
              <div
                key={line.label}
                className={`flex items-center justify-between gap-4 ${
                  line.isTotal ? "border-t border-border pt-2 text-base font-semibold" : "text-sm"
                }`}
              >
                <dt className={line.isTotal ? "" : "text-muted-foreground"}>{line.label}</dt>
                <dd className="tabular-nums">
                  {line.amount < 0 ? `− ${formatEGP(-line.amount)}` : formatEGP(line.amount)}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="Confirmation email">
          {email ? (
            <div className="flex items-start gap-3">
              {email.status === "sent" ? (
                <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <MailX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              )}
              <div className="text-sm">
                <p className="font-medium">
                  {email.status === "sent" ? "Sent" : "Failed to send"}
                </p>
                <p className="adm-muted mt-1 text-[12.5px]">
                  {email.status === "sent"
                    ? formatDate(email.sentAt || "")
                    : `${email.errorCode || "Unknown error"} · ${formatDate(email.failedAt || "")}`}
                </p>
              </div>
            </div>
          ) : (
            <p className="adm-muted text-sm">No confirmation email has been recorded yet.</p>
          )}
        </Section>
      </div>

      <Section title="History" note="Oldest first">
        <ol className="space-y-4">
          {timeline.map((entry, index) => (
            <li key={`${entry.status}-${entry.at}-${index}`} className="flex gap-3">
              <span
                aria-hidden
                className="mt-1.5 size-2 shrink-0 rounded-full bg-border ring-4 ring-card"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium">{entry.label}</p>
                <p className="adm-muted text-[12.5px]">
                  {formatDate(entry.at)} · {entry.actor}
                </p>
                {entry.note && <p className="mt-1 text-[13px]">{entry.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
