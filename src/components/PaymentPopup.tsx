// The payment popup: Paymob's hosted checkout in a frame, over the checkout
// page, so the customer never leaves the site.
//
// The page inside the frame is Paymob's and cannot be read from here. Two
// things tell this component how it went, and neither is trusted on its own:
//
//   - When the customer finishes, Paymob sends the frame to our own
//     /api/payments/paymob/return, which verifies the signed result and records
//     it. That page is same-origin, so its address is readable on load.
//   - A poll of the order's payment status, which is what finally says "paid".
//     It is the only thing that can close this popup as a success, because it
//     reads what the server stored — the webhook may land before the return.

import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { api, type PaymentSession } from "@/lib/api";
import { useLang } from "@/lib/i18n";

const RETURN_PATH = "/api/payments/paymob/return";
const POLL_MS = 3000;

export default function PaymentPopup({
  open, session, reference, phone, onPaid, onClose, onRetry,
}: {
  open: boolean;
  /** null while a fresh session is being opened. */
  session: PaymentSession | null;
  reference: string;
  phone: string;
  onPaid: () => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useLang();
  const frame = useRef<HTMLIFrameElement>(null);
  // Keyed to the session it happened in, so a fresh session starts clean.
  const [declinedIn, setDeclinedIn] = useState<string | null>(null);
  const declined = !!session && declinedIn === session.checkoutUrl;
  const paidRef = useRef(false);
  // Read by the poll without re-arming it every render.
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  async function check() {
    if (paidRef.current) return;
    try {
      const { paymentStatus } = await api.paymentStatus(reference, phone);
      if (paymentStatus === "paid" && !paidRef.current) {
        paidRef.current = true;
        onPaidRef.current();
      }
    } catch {
      // A missed poll is retried by the next one.
    }
  }

  useEffect(() => {
    if (!open || !session) return;
    const timer = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `check` reads refs only
  }, [open, session, reference, phone]);

  function onFrameLoad() {
    let url: URL;
    try {
      // Throws while the frame is on Paymob's (or a bank's) page: cross-origin.
      url = new URL(frame.current?.contentWindow?.location.href ?? "");
    } catch {
      return;
    }
    if (!url.pathname.endsWith(RETURN_PATH)) return;
    if (url.searchParams.get("success") === "true") void check();
    else if (url.searchParams.get("pending") !== "true") setDeclinedIn(session?.checkoutUrl ?? null);
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[800] bg-primary/40 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          className="pay-popup fixed z-[801] flex flex-col bg-soft-oat overflow-hidden shadow-2xl shadow-primary/30 focus:outline-none"
          // The frame takes focus on its own; Radix moving it to the close
          // button first would scroll a phone's sheet to the top of nothing.
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex items-center justify-between gap-4 px-5 py-3 border-b border-[rgb(93_16_29_/_0.12)]">
            <div>
              <DialogPrimitive.Title className="font-display text-[20px] font-semibold text-primary">
                {t.payTitle}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="font-body text-[12px] text-on-surface-variant">
                <span dir="ltr">{reference}</span> · {t.payBy}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close
              className="shrink-0 rounded-full w-9 h-9 grid place-items-center text-primary hover:bg-[rgb(93_16_29_/_0.08)]"
              aria-label={t.payClose}
            >
              <span aria-hidden="true" className="text-[22px] leading-none">×</span>
            </DialogPrimitive.Close>
          </div>

          {declined ? (
            <div className="flex-1 grid place-items-center p-8 text-center">
              <div>
                <p className="font-body text-[15px] text-primary mb-5" role="alert">{t.payDeclined}</p>
                <button type="button" className="ed-btn" onClick={onRetry}>{t.payRetry}</button>
              </div>
            </div>
          ) : session ? (
            <iframe
              key={session.checkoutUrl}
              ref={frame}
              src={session.checkoutUrl}
              title={t.payTitle}
              onLoad={onFrameLoad}
              allow="payment"
              className="flex-1 w-full border-0 bg-white"
            />
          ) : (
            <p className="flex-1 grid place-items-center font-body text-[14px] text-on-surface-variant" role="status">
              {t.payOpening}
            </p>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
