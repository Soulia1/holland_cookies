import { useId } from "react";
import { Link } from "wouter";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import OrderDetailView from "@/components/OrderDetailView";
import { FulfillmentPill, StatusPill } from "@/components/StatusPill";
import { type OrderStatus } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { fulfillmentOf } from "@/lib/orderDetail";
import { useOrderDetail } from "@/lib/useOrderDetail";

/**
 * One order's exact details, over the orders list.
 *
 * Reading an order used to mean leaving the list for /orders/:id and coming
 * back to a page that had reloaded and lost its filters and its place. An
 * operator working through the day's orders opens a dozen of them; the popup
 * keeps the list underneath, so closing it returns to exactly the row they
 * were on.
 *
 * The body is the same OrderDetailView the page renders — a detail that is
 * only on one of the two is a detail somebody will go looking for and not find.
 */
export default function OrderDialog({
  id, open, onOpenChange, onStatusChanged,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Lets the list update the row behind the popup without a refetch. */
  onStatusChanged?: (id: string, status: OrderStatus) => void;
}) {
  const noteFieldId = `${useId()}-status-note`;
  const { order, loading, error, note, setNote, busy, move, reload } =
    useOrderDetail(id, onStatusChanged);
  const type = order ? fulfillmentOf(order) : "delivery";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="adm-dialog-wide"
        aria-describedby={undefined}
        // A status change is a network round trip that writes history. Letting
        // Escape or a stray click dismiss the panel mid-flight would hide
        // whether it landed.
        onEscapeKeyDown={(event) => busy !== "" && event.preventDefault()}
        onInteractOutside={(event) => busy !== "" && event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <DialogTitle>{order?.orderId || "Order"}</DialogTitle>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {order ? `Placed ${formatDate(order.createdAt)}` : "Loading…"}
              </p>
            </div>
            {order && (
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={order.status} fulfillmentType={type} />
                <FulfillmentPill fulfillmentType={type} />
              </div>
            )}
          </div>
        </DialogHeader>

        <DialogBody>
          {error && <p className="adm-error mb-4" role="alert">{error}</p>}

          {!order ? (
            <p className="adm-empty">
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Loading order…
                </span>
              ) : (
                "Order not found."
              )}
            </p>
          ) : (
            // The first section carries its own top margin on the page, where
            // it follows a header. Inside the body it is the first thing there.
            <div className="[&>section:first-child]:mt-0">
              <OrderDetailView
                order={order}
                note={note}
                onNoteChange={setNote}
                busy={busy}
                onMove={move}
                noteFieldId={noteFieldId}
              />
            </div>
          )}
        </DialogBody>

        <DialogFooter className="sm:justify-between">
          {/* A real link, so the order stays shareable and openable in a tab —
              the popup is the quick way in, not the only one. */}
          <Link
            href={`/orders/${id}`}
            className="inline-flex items-center gap-1.5 self-center text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <ExternalLink className="size-3.5" aria-hidden /> Open as a page
          </Link>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={reload} disabled={loading || busy !== ""}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
            {/* "Done", not "Close": the × in the corner is already the control
                named Close, and two buttons with the same accessible name in
                one dialog is a coin toss for anyone navigating by name. */}
            <Button onClick={() => onOpenChange(false)} disabled={busy !== ""}>
              Done
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
