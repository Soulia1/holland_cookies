import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import AreaChart from "@/components/chart/AreaChart";
import Donut from "@/components/chart/Donut";
import {
  Banknote,
  ChartPie,
  CircleArrowDown,
  CircleArrowUp,
  CreditCard,
  Download,
  Ellipsis,
  ReceiptText,
  ShoppingCart,
  Truck,
  UsersRound,
} from "lucide-react";
import OrdersTable from "@/components/OrdersTable";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ordersApi, type Order, type OrderStats, type OrderStatus } from "@/lib/api";
import {
  formatCompact,
  formatCompactEGP,
  formatEGP,
  percentChange,
  TIME_RANGES,
  TIME_RANGE_DAYS,
  TIME_RANGE_LABELS,
  type TimeRange,
} from "@/lib/format";

/** Warm ramp — the chart tokens defined in index.css. */
const DONUT_COLORS = [
  "var(--chart-c1)",
  "var(--chart-c2)",
  "var(--chart-c3)",
  "var(--chart-c4)",
  "var(--chart-c5)",
];
const LINE_COLOR = "var(--chart-line-primary)";
const LINE_COLOR_ALT = "var(--chart-line-secondary)";

type DailyBucket = OrderStats["daily"][number];

type MetricKey = "revenue" | "orders" | "average" | "orderValue";

interface Metric {
  key: MetricKey;
  label: string;
  icon: typeof Banknote;
  /** Series value for a single Cairo day. */
  value: (d: DailyBucket) => number;
  /** Window total from that day series — averages cannot simply be summed. */
  total: (days: DailyBucket[]) => number;
  format: (n: number) => string;
  /** For deltas, a fall in this metric is bad. */
  higherIsBetter: boolean;
}

function sum(days: DailyBucket[], pick: (d: DailyBucket) => number): number {
  return days.reduce((acc, d) => acc + pick(d), 0);
}

const METRICS: Metric[] = [
  {
    key: "revenue",
    label: "Cash collected",
    icon: Banknote,
    value: (d) => d.paidRevenue,
    total: (days) => sum(days, (d) => d.paidRevenue),
    format: formatCompactEGP,
    higherIsBetter: true,
  },
  {
    key: "orders",
    label: "Orders",
    icon: ShoppingCart,
    value: (d) => d.orders,
    total: (days) => sum(days, (d) => d.orders),
    format: formatCompact,
    higherIsBetter: true,
  },
  {
    key: "average",
    label: "Avg. order value",
    icon: CreditCard,
    value: (d) => (d.orders > 0 ? Math.round(d.orderValue / d.orders) : 0),
    total: (days) => {
      const orders = sum(days, (d) => d.orders);
      return orders > 0 ? Math.round(sum(days, (d) => d.orderValue) / orders) : 0;
    },
    format: formatEGP,
    higherIsBetter: true,
  },
  {
    key: "orderValue",
    label: "Order value placed",
    icon: ReceiptText,
    value: (d) => d.orderValue,
    total: (days) => sum(days, (d) => d.orderValue),
    format: formatCompactEGP,
    higherIsBetter: true,
  },
];

function DeltaPill({ change, higherIsBetter }: { change: number | null; higherIsBetter: boolean }) {
  if (change === null || !Number.isFinite(change)) {
    return <span className="text-xs text-muted-foreground">No prior data</span>;
  }
  const rising = change >= 0;
  const good = rising === higherIsBetter;
  const Icon = rising ? CircleArrowUp : CircleArrowDown;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        good ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
      }`}
    >
      <Icon className="size-3.5" aria-hidden />
      {Math.abs(change).toFixed(1)}%
    </span>
  );
}

function PanelHeading({
  icon: Icon,
  title,
  action,
}: {
  icon: typeof Banknote;
  title: string;
  action: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="truncate text-sm font-medium">{title}</h2>
      </div>
      {action}
    </div>
  );
}

function PanelLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
    >
      {children} →
    </a>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<OrderStats | null>(null);
  const [recent, setRecent] = useState<Order[]>([]);
  const [range, setRange] = useState<TimeRange>("1m");
  const [metricKey, setMetricKey] = useState<MetricKey>("revenue");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const days = TIME_RANGE_DAYS[range];

  // Twice the window is requested so the tail is the selected period and the
  // head is the period before it — that is where the comparison figures come
  // from. Metrics are aggregated server-side over every order, so they do not
  // silently under-report past the first page of results.
  async function load(windowDays: number, query: string) {
    try {
      setLoading(true);
      const [summary, page] = await Promise.all([
        ordersApi.stats(windowDays * 2, windowDays),
        ordersApi.list(1, 8, query),
      ]);
      setStats(summary);
      setRecent(page.orders);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the dashboard.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(days, "");
  }, [days]);

  // Debounced so typing does not fire a request per keystroke. Skipped on the
  // first render, where load() has already fetched the unfiltered page.
  const searchReady = useRef(false);
  useEffect(() => {
    if (!searchReady.current) {
      searchReady.current = true;
      return;
    }
    const timer = setTimeout(() => {
      ordersApi
        .list(1, 8, search)
        .then((page) => setRecent(page.orders))
        .catch(() => setError("Failed to search orders."));
    }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  // The aggregates on their own. Separate from load() so a status change can
  // refresh them without the row's spinner waiting on the result.
  const refreshStats = useCallback(async () => {
    try {
      setStats(await ordersApi.stats(days * 2, days));
    } catch {
      // The figures keep their last good values. The status change itself
      // already succeeded, so this must not be reported as a failure.
    }
  }, [days]);

  async function updateStatus(id: string, status: OrderStatus) {
    try {
      await ordersApi.updateStatus(id, status);
      // The server accepted the transition, so the row is updated in place.
      // This used to call load(), which refetches the stats aggregate — and
      // because a status write clears that cache server-side, every single
      // status change paid for a fresh scan of the whole orders collection
      // before the spinner would clear. That is what made the dashboard feel
      // slow on every action.
      setRecent((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)));
      setError("");
      // The totals do shift, so they are refreshed — just not on the critical
      // path of the interaction.
      void refreshStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update order status.");
    }
  }

  async function updatePayment(id: string, paymentStatus: "paid" | "unpaid") {
    try {
      await ordersApi.updatePayment(id, paymentStatus);
      setRecent((prev) => prev.map((o) => (o.id === id ? { ...o, paymentStatus } : o)));
      setError("");
      // This is the one action that moves the Paid revenue card, so the refresh
      // matters more here than it does for a status change — but it stays off the
      // critical path for the same reason.
      void refreshStats();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update payment status.");
    }
  }

  const daily = stats?.daily ?? [];
  const current = daily.slice(-days);
  const previous = daily.slice(0, Math.max(daily.length - days, 0));

  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const chartData = useMemo(
    () => current.map((d) => ({ date: d.date, value: metric.value(d) })),
    [current, metric]
  );

  const totals = stats?.totals;
  const refundDue = totals?.refundDueValue ?? 0;
  const deliveryCount = stats?.byFulfillment.delivery ?? 0;
  const pickupCount = stats?.byFulfillment.pickup ?? 0;
  const fulfillmentTotal = deliveryCount + pickupCount;
  const deliveryPct = fulfillmentTotal ? Math.round((deliveryCount / fulfillmentTotal) * 100) : 0;

  const topProducts = (stats?.topProducts ?? []).slice(0, 4);
  const productTotal = topProducts.reduce((acc, p) => acc + p.quantity, 0);

  const windowOrders = sum(current, (d) => d.orders);
  const ordersChange = percentChange(windowOrders, sum(previous, (d) => d.orders));

  function downloadCsv() {
    const rows = [
      ["date", "orders", "order_value_egp", "paid_revenue_egp"],
      ...current.map((d) => [d.date, d.orders, d.orderValue, d.paidRevenue]),
    ];
    const csv = rows.map((r) => r.join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `holland-cookie-${range}-report.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-[1280px] space-y-4">
      {/* Range control + actions */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="adm-seg flex min-w-0 flex-1 sm:inline-flex sm:flex-none" role="group" aria-label="Time range">
          {TIME_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className="flex-1 sm:flex-none"
              data-active={range === r}
              onClick={() => setRange(r)}
            >
              {TIME_RANGE_LABELS[r]}
            </button>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={downloadCsv}
            aria-label="Download report"
            className="adm-btn adm-btn-ghost max-sm:px-2.5"
          >
            <Download className="size-4" aria-hidden />
            <span className="max-sm:sr-only">Download Report</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Dashboard actions"
                className="rounded-md border border-border bg-card p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Ellipsis className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              <DropdownMenuItem onClick={() => void load(days, search)}>Refresh data</DropdownMenuItem>
              <DropdownMenuItem onClick={downloadCsv}>Download CSV</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {error && <p className="adm-error">{error}</p>}

      {/* Headline metrics — selecting one drives the chart below */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
          {METRICS.map((m) => {
            const value = m.total(current);
            const change = percentChange(m.total(current), m.total(previous));
            const selected = m.key === metricKey;
            const Icon = m.icon;
            return (
              <button
                key={m.key}
                type="button"
                aria-pressed={selected}
                onClick={() => setMetricKey(m.key)}
                className={`p-4 text-start transition-colors sm:p-5 ${
                  selected ? "bg-muted" : "bg-card hover:bg-muted/50"
                }`}
              >
                <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {m.label}
                </span>
                <span className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-2xl font-semibold tracking-tight tabular-nums">
                    {m.format(value)}
                  </span>
                  <DeltaPill change={change} higherIsBetter={m.higherIsBetter} />
                </span>
              </button>
            );
          })}
        </div>

        {/* Selected metric over the window */}
        <div className="border-t border-border px-2 pb-2 pt-6">
          {loading && !stats ? (
            <p className="adm-empty">Loading…</p>
          ) : (
            <AreaChart
              data={chartData}
              name={metric.label}
              format={metric.format}
              formatTick={(v) => formatCompact(v).toLowerCase()}
              height={260}
              color={LINE_COLOR}
            />
          )}
        </div>
      </section>

      {/* Three-panel insight row */}
      <section className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-3">
        {/* Best sellers */}
        <div className="bg-card p-4 sm:p-5">
          <PanelHeading
            icon={ChartPie}
            title="Best Sellers"
            action={<PanelLink href="/dashboard/menu">More details</PanelLink>}
          />
          {productTotal > 0 ? (
            <div className="mt-4 flex items-center gap-4">
              <Donut
                data={topProducts.map((p) => ({ name: p.name, value: p.quantity }))}
                colors={DONUT_COLORS}
                caption="cookies sold"
              />
              <ul className="min-w-0 flex-1 space-y-1">
                {topProducts.map((p, i) => (
                  <li key={p.name} className="flex items-center gap-3 py-1.5">
                    <span
                      aria-hidden
                      className="h-6 w-0.5 shrink-0 rounded-full"
                      style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {p.name}
                    </span>
                    <span className="shrink-0 text-[13px] font-medium tabular-nums">
                      {p.quantity.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="adm-empty">No sales yet.</p>
          )}
          <p className="mt-3 text-xs text-muted-foreground">By quantity · last {days} days</p>
        </div>

        {/* Orders per day */}
        <div className="bg-card p-4 sm:p-5">
          <PanelHeading
            icon={UsersRound}
            title="Orders / Day"
            action={<PanelLink href="/dashboard/orders">View orders</PanelLink>}
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-2xl font-semibold tabular-nums">
                {windowOrders.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                orders in the last {days} days
              </p>
            </div>
            <DeltaPill change={ordersChange} higherIsBetter />
          </div>
          <div className="mt-4">
            <AreaChart
              data={current.map((d) => ({ date: d.date, value: d.orders }))}
              name="Orders"
              format={(n) => `${n} orders`}
              height={110}
              showAxes={false}
              color={LINE_COLOR_ALT}
            />
          </div>
        </div>

        {/* Fulfilment snapshot */}
        <div className="bg-card p-4 sm:p-5">
          <PanelHeading
            icon={Truck}
            title="Fulfilment Snapshot"
            action={<PanelLink href="/dashboard/orders">Full snapshot</PanelLink>}
          />
          <div className="mt-4 grid grid-cols-3 divide-x divide-border">
            <div className="pe-3">
              <p className="text-xs text-muted-foreground">Delivery</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{deliveryCount}</p>
            </div>
            <div className="px-3">
              <p className="text-xs text-muted-foreground">Pickup</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">{pickupCount}</p>
            </div>
            <div className="ps-3">
              <p className="text-xs text-muted-foreground">Avg. basket</p>
              <p className="mt-1 text-xl font-semibold tabular-nums">
                {formatCompactEGP(totals?.averageOrderValue ?? 0)}
              </p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">Delivery vs pickup mix</span>
            <span className="font-medium tabular-nums">
              {deliveryPct}% / {100 - deliveryPct}%
            </span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-[var(--chart-c1)]" style={{ width: `${deliveryPct}%` }} />
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3">
            <div>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="size-2 rounded-full bg-[var(--chart-c1)]" />
                Collected
              </span>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCompactEGP(totals?.paidRevenue ?? 0)}
              </p>
            </div>
            <div>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="size-2 rounded-full bg-[var(--chart-c5)]" />
                Cash to collect
              </span>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCompactEGP(totals?.pendingValue ?? 0)}
              </p>
            </div>
          </div>
          {/* Cancelled after the money was taken. Shown only when there is one,
              so the panel stays quiet in the ordinary case — but never netted
              silently out of "Collected", which would hide the liability. */}
          {refundDue > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="size-2 rounded-full bg-[var(--chart-c3)]" />
                Refund due
              </span>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCompactEGP(refundDue)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Cash collected, then cancelled — owed back to customers.
              </p>
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">All time</p>
        </div>
      </section>

      {/* Recent orders */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <PanelHeading icon={ReceiptText} title="Recent Orders" action={null} />
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <label className="flex flex-1 items-center gap-2 rounded-md border border-border px-2.5 py-1.5 transition-colors focus-within:border-ring sm:flex-none">
              <span className="sr-only">Search orders</span>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search orders…"
                className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground sm:w-56"
              />
            </label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Order list actions"
                  className="rounded-md border border-border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Ellipsis className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-40">
                <DropdownMenuItem onClick={() => void load(days, search)}>Refresh</DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    window.location.href = "/dashboard/orders";
                  }}
                >
                  Open all orders
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="px-4 pb-4 sm:px-5 sm:pb-2">
          <OrdersTable
            orders={recent}
            loading={loading}
            onStatusChange={updateStatus}
            onPaymentChange={updatePayment}
          />
        </div>
      </section>
    </div>
  );
}
