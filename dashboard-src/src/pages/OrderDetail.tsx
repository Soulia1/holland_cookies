import { Link, useRoute } from "wouter";
import { ArrowLeft } from "lucide-react";
import OrderDetailView from "@/components/OrderDetailView";
import { FulfillmentPill, StatusPill } from "@/components/StatusPill";
import { formatDate } from "@/lib/format";
import { fulfillmentOf } from "@/lib/orderDetail";
import { useOrderDetail } from "@/lib/useOrderDetail";

/**
 * One order on its own page.
 *
 * The orders list now opens the same detail in a popup, which is where an
 * operator working through the day's orders actually reads it. This page stays
 * because the URL is the shareable, bookmarkable handle on an order — and
 * because ctrl-clicking a reference in the list has to land somewhere.
 */
export default function OrderDetail() {
  const [, params] = useRoute("/orders/:id");
  const id = params?.id ?? "";
  const { order, loading, error, note, setNote, busy, move, reload } = useOrderDetail(id);

  if (loading && !order) return <p className="adm-empty">Loading order…</p>;
  if (!order) {
    return (
      <div className="adm-page">
        <p className="adm-error">{error || "Order not found."}</p>
        <Link href="/orders" className="adm-btn adm-btn-ghost mt-4 inline-flex">
          <ArrowLeft className="size-4" aria-hidden /> Back to orders
        </Link>
      </div>
    );
  }

  const type = fulfillmentOf(order);

  return (
    <div className="adm-page">
      <header className="adm-head flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href="/orders"
            className="adm-tag inline-flex items-center gap-1.5 hover:text-foreground"
          >
            <ArrowLeft className="size-3" aria-hidden /> Orders
          </Link>
          <h1 className="adm-title">{order.orderId}</h1>
          <p className="adm-sub">Placed {formatDate(order.createdAt)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={order.status} fulfillmentType={type} />
          <FulfillmentPill fulfillmentType={type} />
          <button type="button" className="adm-btn adm-btn-ghost" onClick={reload} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error && <p className="adm-error mb-4">{error}</p>}

      <OrderDetailView
        order={order}
        note={note}
        onNoteChange={setNote}
        busy={busy}
        onMove={move}
      />
    </div>
  );
}
