/**
 * Online payment: the endpoints around Paymob's hosted checkout.
 *
 *   POST /api/payments/paymob/webhook   Paymob → us, server to server. Public,
 *                                       because Paymob holds no session; the
 *                                       HMAC signature is the authentication.
 *   GET  /api/payments/paymob/return    Verify the browser result and return to checkout.
 *   POST /api/payments/session          Open a fresh checkout for an order that
 *                                       is still unpaid: "try again".
 *   GET  /api/payments/status/:ref      What checkout polls after returning.
 *   GET  /api/payments/mock/checkout    PAYMENTS_ONLINE=mock only.
 *
 * The last three identify the order the way tracking does — reference and the
 * phone it was placed with — because references are sequential and guessable.
 */

import { Router } from 'express';
import { z } from 'zod';
import * as orders from '../repo/orders.js';
import { normalizePhone } from '../orderTransaction.js';
import { validateParams, reference as referenceSchema } from '../validation.js';
import { logEvent } from '../security.js';
import { mailConfigured, sendOrderConfirmation, sendAdminOrderAlert } from '../mailer.js';
import { whatsappConfigured, sendWhatsappOrderAlert } from '../whatsapp.js';
import {
  createCheckoutSession, mockResultQuery, paymentMode, referenceFrom, integrationIds, retrieveTransaction,
  transactionFromCallback, transactionFromRedirect, verifyCallback, verifyRedirect, walletPaymentEnabled,
} from '../paymob.js';

const router = Router();
validateParams(router);

/**
 * Where the popup's pages live. In production the configured origin, never a
 * header. In development the page the customer is on — the Vite server, which
 * proxies /api — so that the page Paymob returns to is same-origin with the
 * checkout and the checkout can see it load.
 */
export function publicOrigin(req) {
  if (process.env.NODE_ENV === 'production') return process.env.APP_ORIGIN;
  return req.get('origin') || `${req.protocol}://${req.get('host')}`;
}

/** Open a payment and remember it on the order. Shared with the checkout route. */
export async function openPayment(order, req, { method } = {}) {
  const chosenMethod = method || order.onlineMethod;
  const session = await createCheckoutSession(order, { origin: publicOrigin(req), method: chosenMethod });
  await orders.attachPaymentSession(order.reference, session);
  return { checkoutUrl: session.checkoutUrl };
}

async function applyTransaction(txn, req, via) {
  // merchant_order_id is NOT signed. Only the stored, signed Paymob order ID
  // may select an order, even when the callback includes our reference.
  const reference = await orders.findReferenceByPaymobOrder(txn.paymobOrderId);
  if (!reference) {
    logEvent('payment_unmatched', req, { via, transaction: txn.id });
    return { outcome: 'unmatched' };
  }
  if (paymentMode() !== 'mock' && !integrationIds().includes(txn.integrationId)) {
    logEvent('payment_result', req, { via, reference, outcome: 'integration_mismatch', transaction: txn.id });
    return { outcome: 'integration_mismatch' };
  }
  if (txn.followUp) {
    // refunded_amount_cents and parent_transaction are not signed either.
    // Fetch the original charge over an authenticated server connection.
    const original = await retrieveTransaction(txn.id);
    if (original.paymobOrderId !== txn.paymobOrderId
        || (paymentMode() !== 'mock' && !integrationIds().includes(original.integrationId))) {
      logEvent('payment_result', req, { via, reference, outcome: 'order_mismatch', transaction: txn.id });
      return { outcome: 'order_mismatch' };
    }
    txn = original;
  }
  const result = await orders.recordOnlinePayment(reference, txn, { requestId: req.requestId });
  const outcome = result.found ? result.outcome : 'unmatched';
  // `amount_mismatch` is the line to alert on: a signed payment that does not
  // match the order it names.
  logEvent('payment_result', req, { via, reference, outcome, transaction: txn.id, method: txn.method });
  if (['paid', 'already_paid'].includes(outcome) && result.order?.paymentStatus === 'paid') {
    if (mailConfigured()) {
      // Existing mail claims deduplicate webhook retries. Failure never undoes
      // settlement; a subsequent callback can retry a failed send.
      for (const [event, send] of [
        ['order_email', () => sendOrderConfirmation(result.order, result.order.lang)],
        ['admin_alert', () => sendAdminOrderAlert(result.order)],
      ]) {
        send().then((sent) => {
          if (sent.delivered) logEvent(`${event}_sent`, req, { reference });
        }).catch((error) => logEvent(`${event}_failed`, req, { reference, code: error.code ?? 'UNKNOWN' }));
      }
    }
    if (whatsappConfigured()) {
      sendWhatsappOrderAlert(result.order)
        .then((sent) => { if (sent.delivered) logEvent('whatsapp_alert_sent', req, { reference }); })
        .catch((error) => logEvent('whatsapp_alert_failed', req, { reference, code: error.code ?? 'UNKNOWN' }));
    }
  }
  return { outcome, reference };
}

router.post('/paymob/webhook', async (req, res, next) => {
  try {
    // Paymob also posts saved-card tokens here. Acknowledged and ignored.
    if (req.body?.type !== 'TRANSACTION') return res.json({ ok: true });
    if (!verifyCallback(req.body.obj, req.query.hmac)) {
      logEvent('payment_signature_rejected', req, { via: 'webhook' });
      return res.status(401).json({ error: 'INVALID_SIGNATURE', message: 'Signature did not verify.' });
    }
    const txn = transactionFromCallback(req.body.obj);
    // An unsigned refund hint may trigger inquiry, but never supplies money.
    if (Number(req.body.obj.refunded_amount_cents) > 0) txn.followUp = true;
    const result = await applyTransaction(txn, req, 'webhook');
    // A callback can race the intention write. Ask Paymob to retry it.
    if (result.outcome === 'unmatched') return res.status(503).json({ error: 'PAYMENT_NOT_READY' });
    // 200 for every verified delivery, paid or not: a non-200 makes Paymob
    // retry, and retrying a decline will not turn it into a payment.
    return res.json({ ok: true });
  } catch (error) {
    if (error.code === 'PAYMENT_PROVIDER') {
      logEvent('payment_inquiry_failed', req, { code: error.code });
      return res.status(503).json({ error: 'PAYMENT_INQUIRY', message: 'Retry this callback.' });
    }
    return next(error);
  }
});

const RESULT_TEXT = {
  paid: ['Payment received', 'تم الدفع'],
  declined: ['The payment did not go through', 'الدفع مكملش'],
  pending: ['Your payment is being confirmed', 'بنأكد الدفع'],
  invalid: ['We could not confirm this payment', 'معرفناش نأكد الدفع'],
};

/** A minimal script-free return-error or mock checkout page. */
function sendFramePage(res, status, title, body, extraStyle = '') {
  res.status(status)
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    .type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;color:#5d101d;background:#fdf8f3;text-align:center;padding:24px;box-sizing:border-box}
main{max-width:360px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#5d101d99}a{display:block;margin:10px 0;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}
.pay{background:#5d101d;color:#fff}.decline{border:1px solid #5d101d33;color:#5d101d}small{display:block;margin-top:18px;color:#5d101d80}${extraStyle}</style></head>
<body>${body.startsWith('<div') ? body : `<main>${body}</main>`}</body></html>`);
}

/**
 * The mock's page, laid out like Paymob's own: the amount on the left, the
 * method picker and card form on the right. It is a picture of that page with
 * two working links, so the popup can be seen and judged before the merchant
 * account has keys. Nothing here is a real field.
 */
const MOCK_STYLE = `
body{display:block;padding:0;background:#fff;text-align:start;color:#1f2430;font-size:15px}
.mock{display:flex;min-height:100vh;flex-wrap:wrap}
.mock-left{flex:1 1 300px;background:#f1f2f4;padding:40px 36px;display:flex;flex-direction:column;justify-content:space-between}
.mock-right{flex:1 1 380px;padding:40px 36px;background:#fff}
.mock-brand{font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:13px;color:#1f2430}
.mock-total-label{margin:48px 0 6px;font-size:15px;color:#59606e}
.mock-total{margin:0;font-size:34px;font-weight:700;letter-spacing:-.01em}
.mock-foot{font-size:12.5px;color:#7b8291;margin:0}
.mock-h2{margin:0 0 22px;font-size:21px;font-weight:700}
.mock-label{font-size:13px;color:#59606e;margin:0 0 8px}
.mock-tabs{display:flex;gap:10px;margin-bottom:22px;flex-wrap:wrap}
.mock-tab{display:block;margin:0;flex:1 1 90px;border:1px solid #d8dbe1;border-radius:8px;padding:12px 8px;text-align:center;font-size:13px;font-weight:600;color:#59606e}
.mock-tab.on{border-color:#2f6df6;color:#2f6df6;box-shadow:inset 0 0 0 1px #2f6df6}
.mock-field{border:1px solid #d8dbe1;border-radius:8px;padding:13px 14px;color:#9aa0ac;font-size:14px;margin-bottom:10px}
.mock-split{display:flex;gap:10px}.mock-split>div{flex:1}
.mock-note{margin:22px 0 10px;padding:10px 12px;border-radius:8px;background:#fff7e6;color:#8a5a00;font-size:12.5px}
a.pay{background:#2f6df6;color:#fff;text-align:center}
a.decline{border:1px solid #d8dbe1;color:#59606e;text-align:center}
@media(max-width:700px){.mock-left{padding:24px}.mock-right{padding:24px}.mock-total{font-size:28px}.mock-total-label{margin-top:16px}}
`;

router.get('/paymob/return', async (req, res, next) => {
  try {
    if (!verifyRedirect(req.query)) {
      logEvent('payment_signature_rejected', req, { via: 'return' });
      const [en, ar] = RESULT_TEXT.invalid;
      return sendFramePage(res, 400, en, `<h1>${en}</h1><p dir="rtl">${ar}</p><a href="/checkout">Return to checkout</a>`);
    }
    const txn = transactionFromRedirect(req.query);
    const reference = await orders.findReferenceByPaymobOrder(txn.paymobOrderId);
    if (!reference) return sendFramePage(res, 400, RESULT_TEXT.invalid[0], '<h1>We could not confirm this payment</h1><a href="/checkout">Return to checkout</a>');
    // Mock mode settles locally; it cannot be enabled in production.
    if (paymentMode() === 'mock') await applyTransaction(txn, req, 'mock');
    // Redirects are UX only. A real charge is recorded by the webhook.
    const result = txn.pending || txn.auth ? 'pending' : txn.success && !txn.error ? 'pending' : 'declined';
    return res.redirect(303, `/checkout?payment_return=${encodeURIComponent(reference)}&payment_result=${result}`);
  } catch (error) { return next(error); }
});

const lookupBody = z.strictObject({
  reference: referenceSchema,
  phone: z.string().min(6).max(24),
  method: z.enum(['card', 'wallet', 'online']).optional(),
});

async function findForCustomer(reference, rawPhone) {
  const phone = normalizePhone(rawPhone);
  return phone ? orders.getOrderForTracking(reference, phone) : null;
}

const notFound = (res) => res.status(404).json({
  error: 'NOT_FOUND', message: 'We could not find an order with that reference and phone number.',
});

router.post('/session', async (req, res, next) => {
  try {
    const parsed = lookupBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'INVALID', message: 'Check the request fields.' });
    if (!paymentMode()) {
      return res.status(409).json({ error: 'PAYMENT_UNAVAILABLE', message: 'Online payment is not available right now.' });
    }
    const order = await findForCustomer(parsed.data.reference, parsed.data.phone);
    if (parsed.data.method === 'wallet' && !walletPaymentEnabled()) {
      return res.status(409).json({ error: 'PAYMENT_UNAVAILABLE', message: 'Mobile wallet payment is not available right now.' });
    }
    if (!order) return notFound(res);
    if (order.paymentMethod !== 'online' || order.paymentStatus !== 'unpaid' || order.status === 'cancelled') {
      return res.status(409).json({ error: 'NOTHING_TO_PAY', message: 'This order has nothing left to pay online.' });
    }
    const payment = await openPayment(order, req, { method: parsed.data.method }).catch((error) => {
      logEvent('payment_session_failed', req, { reference: order.reference, code: error.code ?? 'UNKNOWN' });
      return null;
    });
    if (!payment) {
      return res.status(502).json({ error: 'PAYMENT_PROVIDER', message: 'We could not open the payment page. Please try again.' });
    }
    return res.json({ payment });
  } catch (error) { return next(error); }
});

router.get('/status/:reference', async (req, res, next) => {
  try {
    const order = await findForCustomer(req.params.reference, req.query.phone);
    if (!order) return notFound(res);
    return res.json({ paymentStatus: order.paymentStatus, status: order.status, paymentOutcome: order.paymob?.lastResult ?? 'pending' });
  } catch (error) { return next(error); }
});

router.get('/mock/checkout', (req, res) => {
  if (paymentMode() !== 'mock') return res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
  const specialReference = String(req.query.ref ?? '');
  const amountCents = Number(req.query.amount_cents);
  const method = String(req.query.method ?? 'card') === 'wallet' ? 'wallet' : 'card';
  if (!referenceFrom(specialReference) || !Number.isInteger(amountCents)) {
    return res.status(400).json({ error: 'INVALID', message: 'Check the request fields.' });
  }
  const isWallet = method === 'wallet';
  // Relative on purpose: behind the dev proxy the Host header is the API's, not
  // the page's, and the return page has to stay same-origin with the checkout.
  const link = (success) => `/api/payments/paymob/return?${mockResultQuery({ specialReference, amountCents, success, method })}`;
  const amount = (amountCents / 100).toLocaleString('en-EG', { minimumFractionDigits: 2 });
  const picker = `<nav class="mock-tabs" aria-label="Payment method">${['card', 'wallet'].map((option) => {
    const params = new URLSearchParams({ ref: specialReference, amount_cents: String(amountCents), method: option });
    return `<a class="mock-tab${method === option ? ' on' : ''}" ${method === option ? 'aria-current="page"' : ''} href="/api/payments/mock/checkout?${params}">${option === 'card' ? 'Card' : 'Wallet'}</a>`;
  }).join('')}</nav>`;

  const methodForm = isWallet ? `
    ${picker}
    <p class="mock-label">Mobile wallet number (Vodafone Cash / Orange / Etisalat / WE)</p>
    <div class="mock-field" style="color:#1f2430;font-weight:600">010 1234 5678</div>
    <p class="mock-note">Test page — stand-in for Paymob Mobile Wallet. In live mode, Paymob prompts the customer for authorization or OTP. Click below to test.</p>
    <a class="pay" href="${link(true)}">Confirm wallet payment (EGP ${amount})</a>
    <a class="decline" href="${link(false)}">Simulate a declined wallet transaction</a>
  ` : `
    ${picker}
    <p class="mock-label">Card information</p>
    <div class="mock-field">1234 1234 1234 1234</div>
    <div class="mock-split"><div class="mock-field">MM / YY</div><div class="mock-field">CVV</div></div>
    <div class="mock-field">Cardholder name</div>
    <p class="mock-note">Test page — the real Paymob checkout replaces this once the account keys are set. No card is charged and these fields do nothing.</p>
    <a class="pay" href="${link(true)}">Pay EGP ${amount}</a>
    <a class="decline" href="${link(false)}">Simulate a declined card</a>
  `;

  return sendFramePage(res, 200, isWallet ? 'Test wallet payment' : 'Test payment', `<div class="mock">
  <div class="mock-left">
    <div class="mock-brand">Holland Cookies</div>
    <div>
      <p class="mock-total-label">Total Amount</p>
      <p class="mock-total">EGP ${amount}</p>
      <p class="mock-foot" style="margin-top:8px">Order ${referenceFrom(specialReference)}</p>
    </div>
    <p class="mock-foot">Stand-in for <strong>Paymob ${isWallet ? 'Wallets (Vodafone Cash)' : 'Cards'}</strong> · Secure payment</p>
  </div>
  <div class="mock-right">
    <h1 class="mock-h2">Checkout</h1>
    <p class="mock-label">Payment method</p>
    ${methodForm}
  </div>
</div>`, MOCK_STYLE);
});

export default router;
