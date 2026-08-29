import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronDown, Search, UserRound } from "lucide-react";
import { StatusPill } from "@/components/StatusPill";
import { usersApi, type UserDirectory, type UserRecord } from "@/lib/api";
import { formatDate, formatEGP } from "@/lib/format";

type SortKey = "lastOrderAt" | "totalSpent" | "orderCount" | "name";

const SORT_LABELS: Record<SortKey, string> = {
  lastOrderAt: "Most recent",
  totalSpent: "Highest spend",
  orderCount: "Most orders",
  name: "Name (A–Z)",
};

/** Nothing here is masked. The page is behind the admin session and exists so
 *  the shop can reach a customer — a redacted phone number would defeat it. */
function Contact({ user }: { user: UserRecord }) {
  return (
    <div className="space-y-0.5">
      {user.email ? (
        <a
          href={`mailto:${user.email}`}
          className="block max-w-[240px] truncate text-[13px] underline-offset-4 hover:underline"
        >
          {user.email}
        </a>
      ) : (
        <span className="adm-muted text-[13px]">No email</span>
      )}
      {user.phone ? (
        <a
          href={`tel:${user.phone}`}
          className="adm-muted block text-[12px] tabular-nums underline-offset-4 hover:text-foreground hover:underline"
        >
          {user.phone}
        </a>
      ) : (
        <span className="adm-muted block text-[12px]">No phone</span>
      )}
    </div>
  );
}

function OrderHistory({ user }: { user: UserRecord }) {
  if (!user.orders.length) {
    return (
      <p className="adm-muted px-3 py-4 text-[13px]">
        {user.hasAccount
          ? "This customer has an account but has never placed an order."
          : "No orders on file."}
      </p>
    );
  }
  return (
    <div className="px-3 py-3">
      <table className="adm-table">
        <thead>
          <tr>
            <th>Reference</th>
            <th>Placed</th>
            <th>Status</th>
            <th>Fulfilment</th>
            <th className="num">Items</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {user.orders.map((order) => (
            <tr key={order.id}>
              <td className="adm-ref">
                <Link href={`/orders/${order.id}`} className="underline-offset-4 hover:underline">
                  {order.orderId}
                </Link>
              </td>
              <td className="adm-muted whitespace-nowrap text-[12.5px]">
                {order.createdAt ? formatDate(order.createdAt) : "—"}
              </td>
              <td>
                <StatusPill status={order.status} fulfillmentType={order.fulfillmentType} />
              </td>
              <td className="adm-muted text-[12.5px] capitalize">
                {order.fulfillmentType}
                {order.area ? ` · ${order.area}` : ""}
              </td>
              <td className="num">{order.itemCount}</td>
              <td className="num font-medium">{formatEGP(order.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {user.truncatedOrders > 0 && (
        <p className="adm-muted pt-2 text-[12px]">
          Showing the {user.orders.length} most recent of {user.orderCount} orders. The totals above
          cover all {user.orderCount}.
        </p>
      )}
    </div>
  );
}

export default function Users() {
  const [data, setData] = useState<UserDirectory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastOrderAt");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function load(refresh = false) {
    try {
      setLoading(true);
      setData(await usersApi.list(refresh));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load customers.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Searching and sorting happen here rather than on the server: the whole
  // directory is already loaded, and a round trip per keystroke would be slower
  // than the filter it is asking for.
  const rows = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    const filtered = term
      ? data.users.filter((user) =>
          [user.name, user.email, user.phone].some((field) =>
            String(field || "").toLowerCase().includes(term)
          )
        )
      : data.users;
    return [...filtered].sort((a, b) => {
      if (sortKey === "name") return String(a.name || "").localeCompare(String(b.name || ""));
      if (sortKey === "totalSpent") return b.totalSpent - a.totalSpent;
      if (sortKey === "orderCount") return b.orderCount - a.orderCount;
      return String(b.lastOrderAt || "").localeCompare(String(a.lastOrderAt || ""));
    });
  }, [data, search, sortKey]);

  const totals = data?.totals;

  return (
    <div className="adm-page">
      <header className="adm-head flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="adm-tag">Customers</span>
          <h1 className="adm-title">Users</h1>
          <p className="adm-sub">
            Everyone who has ordered or signed up — contact details, order counts and lifetime spend.
          </p>
        </div>
        <button
          type="button"
          className="adm-btn adm-btn-ghost"
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && <p className="adm-error mb-6">{error}</p>}

      {totals && (
        <div className="adm-stats">
          <div className="adm-stat">
            <span className="adm-stat-label">Customers</span>
            <span className="adm-stat-value">{totals.users}</span>
            <span className="adm-stat-note">
              {totals.withAccount} with an account · {totals.guests} guest
              {totals.guests === 1 ? "" : "s"}
            </span>
          </div>
          <div className="adm-stat">
            <span className="adm-stat-label">Repeat customers</span>
            <span className="adm-stat-value">{totals.repeatCustomers}</span>
            <span className="adm-stat-note">More than one order placed</span>
          </div>
          <div className="adm-stat">
            <span className="adm-stat-label">Lifetime value</span>
            <span className="adm-stat-value">{formatEGP(totals.orderValue)}</span>
            <span className="adm-stat-note">Cancelled orders excluded</span>
          </div>
          <div className="adm-stat">
            <span className="adm-stat-label">Never ordered</span>
            <span className="adm-stat-value">{totals.neverOrdered}</span>
            <span className="adm-stat-note">Signed up but not yet bought</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2.5 border-b border-border pb-3 sm:gap-4">
        <div className="flex w-full items-center gap-2 sm:w-auto sm:min-w-[240px] sm:flex-1">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            className="adm-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or phone…"
            aria-label="Search customers"
          />
        </div>
        <select
          className="adm-input w-full sm:max-w-[180px]"
          aria-label="Sort customers"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <option key={key} value={key}>
              {SORT_LABELS[key]}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto pt-2">
        {loading && !data ? (
          <p className="adm-empty">Loading customers…</p>
        ) : !rows.length ? (
          <p className="adm-empty">
            {search ? "No customer matches that search." : "No customers yet."}
          </p>
        ) : (
          <table className="adm-table min-w-[720px]">
            <thead>
              <tr>
                <th className="w-9 pe-0" />
                <th>Customer</th>
                <th>Contact</th>
                <th className="num">Orders</th>
                <th className="num">Total spent</th>
                <th className="num">Avg order</th>
                <th>Last order</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((user) => {
                const open = expanded.has(user.key);
                return [
                  <tr key={user.key}>
                    <td className="pe-0">
                      <button
                        type="button"
                        onClick={() => toggle(user.key)}
                        aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} orders for ${user.name || user.email}`}
                        className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <ChevronDown
                          className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
                        />
                      </button>
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{user.name || "Unnamed customer"}</span>
                        {user.hasAccount && (
                          <span
                            title="Has a signed-in account"
                            className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          >
                            <UserRound className="size-3" aria-hidden />
                            Account
                          </span>
                        )}
                      </div>
                      {user.cancelledCount > 0 && (
                        <div className="adm-muted text-[12px]">
                          {user.cancelledCount} cancelled · {formatEGP(user.cancelledValue)}
                        </div>
                      )}
                    </td>
                    <td>
                      <Contact user={user} />
                    </td>
                    <td className="num tabular-nums">{user.orderCount}</td>
                    <td className="num font-medium">{formatEGP(user.totalSpent)}</td>
                    <td className="num tabular-nums">{formatEGP(user.averageOrderValue)}</td>
                    <td className="adm-muted whitespace-nowrap text-[12.5px]">
                      {user.lastOrderAt ? formatDate(user.lastOrderAt) : "—"}
                    </td>
                  </tr>,
                  open ? (
                    <tr key={`${user.key}-orders`}>
                      <td colSpan={7} className="bg-accent/40 p-0">
                        <OrderHistory user={user} />
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
