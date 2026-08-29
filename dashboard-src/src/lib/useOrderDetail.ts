import { useCallback, useEffect, useState } from "react";
import { ordersApi, type OrderDetail, type OrderStatus } from "@/lib/api";

/**
 * One order, loaded and moved through its statuses.
 *
 * Shared by the /orders/:id page and the popup the orders list opens, so the
 * two cannot drift into disagreeing about what a status change does. The note
 * travels with the transition onto the history row, and is cleared only once
 * the server has accepted the change.
 */
export interface OrderDetailState {
  order: OrderDetail | null;
  loading: boolean;
  error: string;
  /** Optional, saved on the status-history row the transition writes. */
  note: string;
  setNote: (note: string) => void;
  /** The status currently being applied, or "" when idle. */
  busy: OrderStatus | "";
  move: (next: OrderStatus) => Promise<void>;
  reload: () => Promise<void>;
}

export function useOrderDetail(
  id: string,
  /** Told the new status once the server accepts it, so a list behind a popup
   *  can update the row without refetching the whole page of orders. */
  onStatusChanged?: (id: string, status: OrderStatus) => void,
): OrderDetailState {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<OrderStatus | "">("");

  const reload = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      setOrder(await ordersApi.get(id));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the order.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const move = useCallback(async (next: OrderStatus) => {
    setBusy(next);
    setError("");
    try {
      await ordersApi.updateStatus(id, next, note);
      setNote("");
      onStatusChanged?.(id, next);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update the order.");
    } finally {
      setBusy("");
    }
  }, [id, note, onStatusChanged, reload]);

  return { order, loading, error, note, setNote, busy, move, reload };
}
