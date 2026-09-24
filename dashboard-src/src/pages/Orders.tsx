import { useEffect, useMemo, useRef, useState } from "react";
import { useSearch } from "wouter";
import { Loader2, Search, X } from "lucide-react";
import OrderDialog from "@/components/OrderDialog";
import OrdersTable from "@/components/OrdersTable";
import { ordersApi, type Order, type OrderStatus } from "@/lib/api";
import {
  ORDER_STATUSES,
  statusLabel,
  type FulfillmentType,
} from "@shared/orderStatus.mjs";

/**
 * Long enough that typing a name is one request rather than one per letter,
 * short enough that a pause between words already shows the answer. The input
 * itself is never debounced — what the operator typed is on screen the same
 * frame they typed it, and only the request behind it waits.
 */
const SEARCH_DEBOUNCE_MS = 150;

const PAGE_SIZE = 25;

/**
 * How often an open Orders page asks whether the order book has changed. An
 * unchanged book is a bodiless 304, so this is cheap; it is what makes a new
 * order appear without pressing Refresh.
 */
const BOOK_REFRESH_MS = 15_000;

export default function Orders() {
  const queryString = useSearch();
  const initialQuery = () => new URLSearchParams(queryString).get("q") || "";
  // The first page as it was last seen, if it was: the table opens on it and
  // the request below replaces it, rather than opening on a spinner.
  const [opening] = useState(() => ordersApi.peekList(1, PAGE_SIZE, initialQuery()));
  const [orders, setOrders] = useState<Order[]>(() => opening?.orders ?? []);
  const [loading, setLoading] = useState(!opening);
  const [error, setError] = useState("");
  const [search, setSearch] = useState(initialQuery);
  const [appliedSearch, setAppliedSearch] = useState(initialQuery);
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "">("");
  const [typeFilter, setTypeFilter] = useState<FulfillmentType | "">("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(opening?.hasMore ?? false);
  const [total, setTotal] = useState<number | null>(opening?.total ?? null);
  // Bumped to re-run the load effect for the same query — Refresh, Retry, and
  // the refetch after a status change that may have moved a row off the page.
  const [reloadNonce, setReloadNonce] = useState(0);
  // The order whose details are open over the list, if any.
  const [viewing, setViewing] = useState<Order | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // Guards against an older request landing after a newer one. Two requests can
  // be in flight when the first has been aborted but its rejection has not been
  // delivered yet, and only the newest may write to state.
  const latestRequest = useRef(0);
  // Bumped whenever the order book changes, so the local answer is recomputed.
  const [bookTick, setBookTick] = useState(0);
  const [bookRefreshing, setBookRefreshing] = useState(false);

  // Keep the order book current while this page is open and looked at: now, on
  // an interval, and the moment the operator comes back to the tab.
  useEffect(() => {
    const off = ordersApi.onBook(() => setBookTick((tick) => tick + 1));
    const revalidate = () => {
      if (document.visibilityState === "visible") ordersApi.book().catch(() => {});
    };
    revalidate();
    const timer = setInterval(revalidate, BOOK_REFRESH_MS);
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener("focus", revalidate);
    return () => {
      off();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener("focus", revalidate);
    };
  }, []);

  // The answer from the order book held in the browser, for exactly what is in
  // the search box right now — no debounce and no request, so it is on screen
  // the frame after the key is pressed. Used whenever the book holds every
  // order; otherwise the server is asked, below, as before.
  const local = useMemo(
    () => ordersApi.localList(page, PAGE_SIZE, search, { status: statusFilter, fulfillmentType: typeFilter }),
    // bookTick stands in for the book itself, which lives outside React.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bookTick, page, search, statusFilter, typeFilter],
  );
  const localComplete = Boolean(local?.complete);

  /** Apply a query now rather than on the debounce — Enter, and the clear
   *  button, are both explicit and should not make the operator wait. */
  function applySearch(next: string) {
    setSearch(next);
    setAppliedSearch(next);
    // A result set is always entered from its first page. Staying on page 5 of
    // a one-page result is an empty screen that looks exactly like no matches.
    setPage(1);
  }

  useEffect(() => {
    if (search === appliedSearch) return;
    // A query already answered once — backspacing, retyping — is applied at
    // once: its rows are in memory, so there is no request to spare the server.
    const answered = ordersApi.peekList(1, PAGE_SIZE, search, {
      status: statusFilter,
      fulfillmentType: typeFilter,
    });
    const timer = setTimeout(() => {
      setAppliedSearch(search);
      setPage(1);
    }, answered ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, appliedSearch, statusFilter, typeFilter]);

  useEffect(() => {
    // The order book already answers this, in the browser.
    if (localComplete) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const token = ++latestRequest.current;

    const filters = { status: statusFilter, fulfillmentType: typeFilter };
    // Show what this exact view held last time straight away; the request
    // below still runs and replaces it.
    const seen = ordersApi.peekList(page, PAGE_SIZE, appliedSearch, filters);
    if (seen) {
      setOrders(seen.orders);
      setTotal(seen.total ?? null);
      setHasMore(seen.hasMore);
      setError("");
    }

    (async () => {
      try {
        setLoading(!seen);
        // There is no "today's fulfilments" view: checkout does not ask for a
        // delivery or pickup date, so there is no date to filter on.
        const result = await ordersApi.list(page, PAGE_SIZE, appliedSearch, filters, controller.signal);
        if (token !== latestRequest.current) return;
        setOrders(result.orders);
        setTotal(result.total ?? null);
        setHasMore(result.hasMore);
        setError("");
      } catch (err) {
        // An abort is this component replacing its own request, not a failure.
        if (controller.signal.aborted || token !== latestRequest.current) return;
        // The rows already on screen stay there. A dropped connection while
        // refining a search should not also take away what was found.
        setError(err instanceof Error ? err.message : "Failed to load orders.");
      } finally {
        if (token === latestRequest.current) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [page, appliedSearch, statusFilter, typeFilter, reloadNonce, localComplete]);

  useEffect(() => {
    const q = new URLSearchParams(queryString).get("q");
    if (q) applySearch(q);
  }, [queryString]);

  async function handleStatusChange(id: string, status: OrderStatus) {
    try {
      await ordersApi.updateStatus(id, status);
      setError("");
      // Under a status filter the row may no longer belong on this page at all,
      // so the list has to come back from the server for it to leave. Without
      // one, nothing about which orders match has changed — the row is updated
      // where it sits rather than making the operator wait for a refetch.
      if (statusFilter) {
        setReloadNonce((value) => value + 1);
        return;
      }
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update order status.");
    }
  }

  /**
   * A status moved from inside the details popup.
   *
   * The popup has already sent the change; this only reconciles the list
   * behind it, on the same rule the row's own menu follows — a status filter
   * can push the order off the page, so that case has to come from the server.
   */
  function handleViewedStatusChange(id: string, status: OrderStatus) {
    if (statusFilter) {
      setReloadNonce((value) => value + 1);
      return;
    }
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)));
  }

  // No refetch branch here, unlike handleStatusChange: payment is not one of the
  // filters this page offers, so marking a row paid can never move it off the
  // page and the row can be updated where it sits.
  async function handlePaymentChange(id: string, paymentStatus: "paid" | "unpaid") {
    try {
      await ordersApi.updatePayment(id, paymentStatus);
      setError("");
      setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, paymentStatus } : o)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update payment status.");
    }
  }

  // Filtering is done by the server. So is the ranking behind a search, which
  // puts the reference you typed in full above the newest order that merely
  // contains those characters — so a search keeps the order it arrived in, and
  // only the unsearched list is re-sorted into newest-first here.
  const filtered = useMemo(
    () =>
      appliedSearch
        ? orders
        : [...orders].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        ),
    [orders, appliedSearch]
  );

  // What is on screen: the order book's answer when it has every order,
  // otherwise the server's.
  const view = localComplete ? local! : null;
  const rows = view ? view.orders : filtered;
  const shownQuery = view ? search.trim() : appliedSearch;
  const shownTotal = view ? view.total : total;
  const shownHasMore = view ? view.hasMore : hasMore;
  const busy = view ? bookRefreshing : loading;

  // True while what is on screen is older than what has been typed: during the
  // debounce, and while the request it fires is still out. Never, when the
  // order book answers.
  const searching = !view && Boolean(search) && (search !== appliedSearch || loading);

  /** Refresh: the order book when it is what is shown, otherwise the page. */
  function refresh() {
    if (!view) {
      setReloadNonce((value) => value + 1);
      return;
    }
    setBookRefreshing(true);
    ordersApi.book()
      .then(() => setError(""))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load orders."))
      .finally(() => setBookRefreshing(false));
  }

  // The total is the count of everything matching the filters, not of the rows
  // on this page.
  const countLine = shownTotal === null
    ? `Page ${page}`
    : shownQuery
      ? `Page ${page} · ${shownTotal} ${shownTotal === 1 ? "match" : "matches"} for “${shownQuery}”`
      : `Page ${page} of ${Math.max(1, Math.ceil(shownTotal / PAGE_SIZE))} · ${shownTotal} ${shownTotal === 1 ? "order" : "orders"}`;

  return (
    <div className="adm-page">
      <header className="adm-head flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="adm-tag">Fulfilment</span>
          <h1 className="adm-title">Orders</h1>
          <p className="adm-sub">{countLine}</p>
        </div>
        <button
          type="button"
          className="adm-btn adm-btn-ghost"
          onClick={refresh}
          disabled={busy}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {/* A failed request is the only thing that belongs here. A search that
          matched nothing is a result, and it is reported in the table below. */}
      {error && (
        <div className="adm-error mb-6 flex flex-wrap items-center justify-between gap-3">
          <span role="alert">{error}</span>
          <button
            type="button"
            className="shrink-0 font-medium underline underline-offset-4"
            onClick={refresh}
          >
            Retry
          </button>
        </div>
      )}

      {/* Every control is full width on a phone and only lines up into a row
          once there is width for one — wrapping them at desktop sizes left a
          column of half-cut selects on mobile. */}
      <div className="flex flex-wrap items-end gap-2.5 border-b border-border pb-3 sm:gap-4">
        <form
          className="flex w-full items-center gap-2 sm:w-auto sm:min-w-[240px] sm:flex-1"
          role="search"
          onSubmit={(event) => {
            // Results are already live; Enter only skips the remaining wait.
            event.preventDefault();
            applySearch(search);
          }}
        >
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={searchInput}
            className="adm-input"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              // The order book answers as it is typed, and always from page 1.
              if (localComplete) setPage(1);
            }}
            placeholder="Search orders, customers, phone…"
            aria-label="Search orders"
            autoComplete="off"
            enterKeyHint="search"
          />
          {searching && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          )}
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              className="-m-2 shrink-0 p-2 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                applySearch("");
                searchInput.current?.focus();
              }}
            >
              <X className="size-4" aria-hidden />
            </button>
          )}
        </form>
        <select
          className="adm-input min-w-0 flex-1 sm:max-w-[170px] sm:flex-none"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(e) => { setPage(1); setStatusFilter(e.target.value as OrderStatus | ""); }}
        >
          <option value="">All statuses</option>
          {ORDER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {/* Labels differ per fulfilment type, so the filter shows the
                  neutral delivery wording and the rows show the real one. */}
              {statusLabel(status, "delivery")}
            </option>
          ))}
        </select>
        <select
          className="adm-input min-w-0 flex-1 sm:max-w-[150px] sm:flex-none"
          aria-label="Filter by fulfilment type"
          value={typeFilter}
          onChange={(e) => { setPage(1); setTypeFilter(e.target.value as FulfillmentType | ""); }}
        >
          <option value="">All types</option>
          <option value="delivery">Delivery</option>
          <option value="pickup">Pickup</option>
        </select>
      </div>

      <div className="pt-2">
        <OrdersTable
          orders={rows}
          loading={view ? false : loading}
          highlight={shownQuery}
          emptyMessage={
            shownQuery ? `No orders found matching “${shownQuery}”.` : "No orders yet."
          }
          onOpenOrder={setViewing}
          onStatusChange={handleStatusChange}
          onPaymentChange={handlePaymentChange}
        />
      </div>

      {/* Keyed on the order, so opening a second one loads it from scratch
          rather than showing the previous order's details while it fetches. */}
      {viewing && (
        <OrderDialog
          key={viewing.id}
          id={viewing.id}
          open
          onOpenChange={(next) => !next && setViewing(null)}
          onStatusChanged={handleViewedStatusChange}
        />
      )}

      <div className="mt-8 flex gap-3 sm:justify-end">
        <button
          type="button"
          className="adm-btn adm-btn-ghost flex-1 sm:flex-none"
          disabled={page === 1 || (!view && loading)}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className="adm-btn adm-btn-ghost flex-1 sm:flex-none"
          disabled={!shownHasMore || (!view && loading)}
          onClick={() => setPage((value) => value + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
