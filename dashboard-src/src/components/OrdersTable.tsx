import { useMemo, useState, type MouseEvent } from "react";
import { Link } from "wouter";
import { Banknote, ChevronsUpDown, CircleCheck, Ellipsis, Loader2, Phone } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { FulfillmentPill, StatusPill } from "@/components/StatusPill";
import { ordersApi, type Order } from "@/lib/api";
import {
  bundleContents, formatDate, formatEGP,
} from "@/lib/format";
import { fulfillmentOf } from "@/lib/orderDetail";
import { highlightSegments } from "@/lib/orderSearch";
import {
  allowedNextStatuses,
  statusLabel,
  type FulfillmentType,
  type OrderStatus,
} from "@shared/orderStatus.mjs";

type SortKey = "orderId" | "name" | "total" | "createdAt" | "status";

/**
 * True when a click on a link means "not here" — a new tab, a new window, or
 * a download.
 *
 * The reference opens the details in a popup, but it stays a real link to
 * /orders/:id underneath. Swallowing every click would take away opening an
 * order in a background tab, which is how anyone lines up a morning's work.
 */
function opensElsewhere(event: MouseEvent): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

/**
 * The part of a value the current search matched, marked.
 *
 * `<mark>` and nothing else: the emphasis is the point, and a screen reader
 * still reads the name as one uninterrupted string.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => highlightSegments(text, query), [text, query]);
  if (segments.length === 1) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) => (
        segment.match
          ? <mark key={index} className="rounded-[2px] bg-primary/20 text-inherit">{segment.text}</mark>
          : <span key={index}>{segment.text}</span>
      ))}
    </>
  );
}

function itemCount(order: Order): number {
  if (!Array.isArray(order.items)) return 0;
  return order.items.reduce((acc, item) => acc + (Number(item.qty) || 0), 0);
}

function SortHead({
  label, sortKey, active, onSort, numeric,
}: {
  label: string; sortKey: SortKey; active: boolean;
  onSort: (key: SortKey) => void; numeric?: boolean;
}) {
  return (
    <th className={numeric ? "num" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1.5 transition-colors hover:text-foreground ${
          active ? "text-foreground" : ""
        } ${numeric ? "flex-row-reverse" : ""}`}
      >
        {label}
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
      </button>
    </th>
  );
}

/**
 * What was ordered, with bundles opened up.
 *
 * A bundle line used to collapse to its own name in this list, so an operator
 * reading the orders page had no way to see what was inside one without
 * opening the order. Contents are shown inline instead, capped so a large
 * order does not take over the row.
 */
function ItemLines({ items, limit = 3 }: { items: Order["items"]; limit?: number }) {
  if (!Array.isArray(items) || !items.length) {
    return <span className="adm-muted">—</span>;
  }
  const shown = items.slice(0, limit);
  const hidden = items.length - shown.length;
  return (
    <ul className="space-y-1">
      {shown.map((item, index) => {
        const contents = bundleContents(item);
        return (
          <li key={`${item.name}-${index}`} className="leading-snug">
            <span className="text-foreground">
              {item.qty}× {item.name}
            </span>
            {contents.length > 0 && (
              <span className="adm-muted block ps-3 text-[12px]">↳ {contents.join(", ")}</span>
            )}
          </li>
        );
      })}
      {hidden > 0 && <li className="adm-muted text-[12px]">+{hidden} more</li>}
    </ul>
  );
}

/**
 * Whether the cash for a completed order has been collected.
 *
 * Cash on delivery is the only payment method, so this is the shop's own record
 * of the handover — not an online payment. Reversible on purpose: the only other
 * way to undo a misclick is a Firestore script. The server audits both directions.
 */
function PaymentControl({
  paid, busy, onChange,
}: {
  paid: boolean;
  busy: boolean;
  onChange: (paymentStatus: "paid" | "unpaid") => void;
}) {
  if (busy) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />;
  }
  if (!paid) {
    return (
      <button
        type="button"
        onClick={() => onChange("paid")}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-medium whitespace-nowrap transition-colors hover:bg-accent hover:text-foreground"
      >
        <Banknote className="size-3.5 shrink-0" aria-hidden />
        Mark cash collected
      </button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Styled as the same pill the Status column uses, so "paid" reads as a
            state of the order rather than a fifth kind of button. */}
        <button type="button" className="adm-pill is-done cursor-pointer whitespace-nowrap" aria-label="Cash collected">
          <CircleCheck className="size-3.5 shrink-0" aria-hidden />
          Cash collected
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onClick={() => onChange("unpaid")}>
          Mark cash not collected
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The row's controls, shared by the table row and the mobile card.
 *
 * `completed` and `cancelled` have no legal next status, so this column used to
 * render a dead dash on the rows that matter most. A completed order is exactly
 * where the money question lives — every order is cash on handover — so it gets
 * the payment control in place of the empty menu. Cancelled stays a dash:
 * nothing was fulfilled and nothing is owed either way.
 */
function RowActions({
  order, fulfillmentType, busy, onChange, paymentBusy, onPaymentChange, className = "",
}: {
  order: Order;
  fulfillmentType: FulfillmentType;
  busy: boolean;
  onChange: (status: OrderStatus) => void;
  paymentBusy: boolean;
  onPaymentChange: (paymentStatus: "paid" | "unpaid") => void;
  className?: string;
}) {
  const next = allowedNextStatuses(order.status, fulfillmentType);
  if (!next.length) {
    if (order.status !== "completed") return <span className="text-muted-foreground">—</span>;
    return (
      <PaymentControl
        paid={order.paymentStatus === "paid"}
        busy={paymentBusy}
        onChange={onPaymentChange}
      />
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for order ${order.orderId}`}
          disabled={busy}
          className={`rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 ${className}`}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Ellipsis className="size-4" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {next.map((status) => (
          <DropdownMenuItem
            key={status}
            variant={status === "cancelled" ? "destructive" : "default"}
            onClick={() => onChange(status)}
          >
            Mark as {statusLabel(status, fulfillmentType).toLowerCase()}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default function OrdersTable({
  orders,
  loading = false,
  highlight = "",
  emptyMessage = "No orders yet.",
  onOpenOrder,
  onStatusChange,
  onPaymentChange,
}: {
  orders: Order[];
  loading?: boolean;
  /** The active search, marked up wherever it appears in a reference or name. */
  highlight?: string;
  /** Opens the order's details over the list. Absent → the reference just
   *  navigates, which is what the /orders/:id page still relies on. */
  onOpenOrder?: (order: Order) => void;
  /** Why the list is empty. "No orders yet" and "nothing matched what you
   *  typed" are different answers, and the caller is the one that knows which. */
  emptyMessage?: string;
  /** Must report its own failures — the row only tracks that one is in flight. */
  onStatusChange: (id: string, status: OrderStatus) => Promise<void>;
  /** Same contract as onStatusChange: it owns its own error reporting. */
  onPaymentChange: (id: string, paymentStatus: "paid" | "unpaid") => Promise<void>;
}) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Addresses are fetched only when an operator asks, so a routine glance at the
  // order list doesn't pull every customer's location into the browser.
  const [addresses, setAddresses] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState("");
  const [statusBusyId, setStatusBusyId] = useState("");
  const [paymentBusyId, setPaymentBusyId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function sort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const rows = useMemo(() => {
    if (!sortKey) return orders;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...orders].sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [orders, sortKey, sortDir]);

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((o) => selected.has(o.id));

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((o) => o.id)));
  }

  async function changeStatus(id: string, status: OrderStatus) {
    setStatusBusyId(id);
    try {
      await onStatusChange(id, status);
    } finally {
      setStatusBusyId("");
    }
  }

  async function changePayment(id: string, paymentStatus: "paid" | "unpaid") {
    setPaymentBusyId(id);
    try {
      await onPaymentChange(id, paymentStatus);
    } finally {
      setPaymentBusyId("");
    }
  }

  async function revealAddress(order: Order) {
    if (addresses[order.id]) return;
    setBusyId(order.id);
    try {
      const details = await ordersApi.get(order.id);
      setAddresses((prev) => ({
        ...prev,
        [order.id]: details.fulfillmentType === "pickup"
          ? "Pickup — collect from the bakery"
          : [details.address, details.area].filter(Boolean).join(", ") || "No address on file",
      }));
    } catch {
      setAddresses((prev) => ({ ...prev, [order.id]: "Could not load the address." }));
    } finally {
      setBusyId("");
    }
  }

  if (loading && !orders.length) return <p className="adm-empty">Loading orders…</p>;
  if (!orders.length) return <p className="adm-empty">{emptyMessage}</p>;

  return (
    <>
      {/* ── Phone: one card per order ────────────────────────────────────
          Ten columns in a horizontal scroller is not a list anyone can work
          from on a phone, so below `md` each order becomes a card carrying
          the same facts stacked in reading order. ──────────────────────── */}
      <ul className="space-y-2.5 lg:hidden">
        {rows.map((order) => {
          const fulfillmentType = fulfillmentOf(order);
          const isPickup = fulfillmentType === "pickup";
          const revealed = addresses[order.id];
          return (
            <li
              key={order.id}
              className="rounded-xl border border-border bg-card p-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={selected.has(order.id)}
                  onChange={() => toggleRow(order.id)}
                  aria-label={`Select order ${order.orderId}`}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/orders/${order.id}`}
                    className="adm-ref text-[15px] underline-offset-4 hover:underline"
                    onClick={(event) => {
                      if (!onOpenOrder || opensElsewhere(event)) return;
                      event.preventDefault();
                      onOpenOrder(order);
                    }}
                  >
                    <Highlight text={order.orderId} query={highlight} />
                  </Link>
                  <div className="truncate text-[13px] text-muted-foreground">
                    {formatDate(order.createdAt)}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusPill status={order.status} fulfillmentType={fulfillmentType} />
                  <RowActions
                    order={order}
                    fulfillmentType={fulfillmentType}
                    busy={statusBusyId === order.id}
                    onChange={(status) => void changeStatus(order.id, status)}
                    paymentBusy={paymentBusyId === order.id}
                    onPaymentChange={(next) => void changePayment(order.id, next)}
                  />
                </div>
              </div>

              <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3">
                <div className="min-w-0 truncate text-sm font-medium">
                  <Highlight text={order.name} query={highlight} />
                </div>
                <div className="shrink-0 text-base font-semibold tabular-nums">
                  {formatEGP(order.total)}
                </div>
              </div>

              <div className="mt-2 text-[13px]">
                <ItemLines items={order.items} limit={4} />
                <p className="adm-muted mt-1 text-[12px]">{itemCount(order)} pcs in total</p>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[12.5px] text-muted-foreground">
                <FulfillmentPill fulfillmentType={fulfillmentType} />
                <span>{isPickup ? "Collect from the bakery" : order.area || "No area"}</span>
              </div>

              {revealed && <p className="mt-2 text-[12.5px]">{revealed}</p>}

              {/* Calling the customer is the single most common next action on
                  a phone, so it gets a real button rather than a small link. */}
              <div className="mt-3 flex gap-2">
                {order.phone && (
                  <a
                    href={`tel:${order.phone}`}
                    className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-3 text-[13px] font-medium transition-colors hover:bg-accent"
                  >
                    <Phone className="size-3.5" aria-hidden />
                    Call
                  </a>
                )}
                {!revealed && (
                  <button
                    type="button"
                    onClick={() => revealAddress(order)}
                    disabled={busyId === order.id}
                    className="inline-flex min-h-9 flex-1 items-center justify-center rounded-md border border-border px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                  >
                    {busyId === order.id ? "Loading…" : "Show address"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* ── Desktop: the full table ────────────────────────────────────
          The min-width is what makes the scroller work. Without it the table
          shrank to fit its column instead, wrapping "Chocolate Chip" down one
          letter-cramped line per word. ─────────────────────────────────── */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="adm-table min-w-[880px]">
          <thead>
            <tr>
              <th className="w-9 pe-0">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all orders"
                  className="size-4 accent-primary align-middle"
                />
              </th>
              <SortHead label="Reference" sortKey="orderId" active={sortKey === "orderId"} onSort={sort} />
              <SortHead label="Customer" sortKey="name" active={sortKey === "name"} onSort={sort} />
              <th>Items</th>
              <SortHead label="Status" sortKey="status" active={sortKey === "status"} onSort={sort} />
              <th className="num">Qty</th>
              <th>Fulfilment</th>
              <SortHead label="Placed" sortKey="createdAt" active={sortKey === "createdAt"} onSort={sort} />
              <SortHead label="Total" sortKey="total" active={sortKey === "total"} onSort={sort} numeric />
              <th className="num">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((order) => {
              const fulfillmentType = fulfillmentOf(order);
              const isPickup = fulfillmentType === "pickup";
              const revealed = addresses[order.id];
              return (
                <tr key={order.id}>
                  <td className="pe-0">
                    <input
                      type="checkbox"
                      checked={selected.has(order.id)}
                      onChange={() => toggleRow(order.id)}
                      aria-label={`Select order ${order.orderId}`}
                      className="size-4 accent-primary align-middle"
                    />
                  </td>
                  <td className="adm-ref">
                    {/* The reference is the way in to everything about one order:
                        the full address, the money breakdown, and the history. */}
                    <Link
                      href={`/orders/${order.id}`}
                      className="underline-offset-4 hover:underline"
                      onClick={(event) => {
                        if (!onOpenOrder || opensElsewhere(event)) return;
                        event.preventDefault();
                        onOpenOrder(order);
                      }}
                    >
                      <Highlight text={order.orderId} query={highlight} />
                    </Link>
                  </td>
                  <td>
                    <div className="font-medium">
                      <Highlight text={order.name} query={highlight} />
                    </div>
                    {/* Shown in full. This table is behind the admin session, and
                        an operator chasing a delivery needs to dial the number,
                        not open the order to find out what it is. */}
                    {order.phone ? (
                      <a
                        href={`tel:${order.phone}`}
                        className="adm-muted text-[12px] tabular-nums underline-offset-4 hover:text-foreground hover:underline"
                      >
                        <Highlight text={order.phone} query={highlight} />
                      </a>
                    ) : (
                      <div className="adm-muted text-[12px]">No phone</div>
                    )}
                  </td>
                  <td className="max-w-[260px] text-[13px]">
                    <ItemLines items={order.items} />
                  </td>
                  <td><StatusPill status={order.status} fulfillmentType={fulfillmentType} /></td>
                  <td className="num">{itemCount(order)}</td>
                  <td>
                    <FulfillmentPill fulfillmentType={fulfillmentType} />
                    <div className="adm-muted mt-1 text-[12px]">
                      {isPickup ? "Collect from the bakery" : order.area || "No area"}
                    </div>
                    {revealed ? (
                      <div className="mt-1 max-w-[220px] text-[12px]">{revealed}</div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => revealAddress(order)}
                        disabled={busyId === order.id}
                        className="mt-1 text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
                      >
                        {busyId === order.id ? "Loading…" : "Show address"}
                      </button>
                    )}
                  </td>
                  <td className="adm-muted whitespace-nowrap text-[12.5px]">{formatDate(order.createdAt)}</td>
                  <td className="num font-medium">{formatEGP(order.total)}</td>
                  <td className="num">
                    <RowActions
                      order={order}
                      fulfillmentType={fulfillmentType}
                      busy={statusBusyId === order.id}
                      onChange={(status) => void changeStatus(order.id, status)}
                      paymentBusy={paymentBusyId === order.id}
                      onPaymentChange={(next) => void changePayment(order.id, next)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
