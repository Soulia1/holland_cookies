import { useEffect, useState } from "react";

/**
 * True from the first time `open` becomes true, and true forever after.
 *
 * Heavy surfaces — the product modal and anything else closed on load — are
 * mounted on first open rather than with the page, so their code is not in the
 * bundle the hero has to wait for. They are deliberately *not* unmounted again
 * on close: a visitor who opened one product is very likely to open another,
 * and tearing the surface down would discard the chunk's warm module state and
 * replay the mount cost on every single open.
 */
export function useOnceOpened(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  return opened;
}
