/**
 * Online payment: the endpoints around the Paymob popup.
 *
 *   POST /api/payments/paymob/webhook   Paymob → us, server to server. Public,
 *                                       because Paymob holds no session; the
 *                                       HMAC signature is the authentication.
 *   GET  /api/payments/paymob/return    Where Paymob sends the popup when the
 *                                       customer is done. Same signature, in
 *                                       the query string. Runs on a laptop too,
 *                                       where no webhook can reach.
 *   POST /api/payments/session          Open a fresh popup for an order that
 *                                       is still unpaid: "try again".
 *   GET  /api/payments/status/:ref      What the popup polls while it is open.
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
import {
  createCheckoutSession, mockResultQuery, paymentMode, referenceFrom,
  transactionFromCallback, transactionFromRedirect, verifyCallback, verifyRedirect,
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
export async function openPayment(order, req) {
  const session = await createCheckoutSession(order, { origin: publicOrigin(req) });
  await orders.attachPaymentSession(order.reference, session);
  return { checkoutUrl: session.checkoutUrl };
}

async function applyTransaction(txn, req, via) {
  const reference = referenceFrom(txn.merchantOrderId)
    ?? await orders.findReferenceByPaymobOrder(txn.paymobOrderId);
  if (!reference) {
    logEvent('payment_unmatched', req, { via, transaction: txn.id });
    return { outcome: 'unmatched' };
  }
  const result = await orders.recordOnlinePayment(reference, txn, { requestId: req.requestId });
  const outcome = result.found ? result.outcome : 'unmatched';
  // `amount_mismatch` is the line to alert on: a signed payment that does not
  // match the order it names.
  logEvent('payment_result', req, { via, reference, outcome, transaction: txn.id, method: txn.method });
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
    await applyTransaction(transactionFromCallback(req.body.obj), req, 'webhook');
    // 200 for every verified delivery, paid or not: a non-200 makes Paymob
    // retry, and retrying a decline will not turn it into a payment.
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

const RESULT_TEXT = {
  paid: ['Payment received', 'تم الدفع'],
  declined: ['The payment did not go through', 'الدفع مكملش'],
  pending: ['Your payment is being confirmed', 'بنأكد الدفع'],
  invalid: ['We could not confirm this payment', 'معرفناش نأكد الدفع'],
};

/** A page with no script, framed only by our own checkout. */
function sendFramePage(res, status, title, body) {
  res.status(status)
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
    .type('html')
    .send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;color:#5d101d;background:#fdf8f3;text-align:center;padding:24px;box-sizing:border-box}
main{max-width:360px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 20px;color:#5d101d99}a{display:block;margin:10px 0;padding:14px;border-radius:10px;text-decoration:none;font-weight:600}
.pay{background:#5d101d;color:#fff}.decline{border:1px solid #5d101d33;color:#5d101d}small{display:block;margin-top:18px;color:#5d101d80}</style></head>
<body><main>${body}</main></body></html>`);
}

router.get('/paymob/return', async (req, res, next) => {
  try {
    if (!verifyRedirect(req.query)) {
      logEvent('payment_signature_rejected', req, { via: 'return' });
      const [en, ar] = RESULT_TEXT.invalid;
      return sendFramePage(res, 400, en, `<h1>${en}</h1><p dir="rtl">${ar}</p>`);
    }
    const { outcome } = await applyTransaction(transactionFromRedirect(req.query), req, 'return');
    const key = ['paid', 'already_paid'].includes(outcome) ? 'paid'
      : outcome === 'pending' ? 'pending' : outcome === 'declined' ? 'declined' : 'invalid';
    const [en, ar] = RESULT_TEXT[key];
    return sendFramePage(res, 200, en, `<h1>${en}</h1><p dir="rtl">${ar}</p>`);
  } catch (error) { return next(error); }
});

const lookupBody = z.strictObject({ reference: referenceSchema, phone: z.string().min(6).max(24) });

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
    if (!order) return notFound(res);
    if (order.paymentMethod !== 'online' || order.paymentStatus !== 'unpaid' || order.status === 'cancelled') {
      return res.status(409).json({ error: 'NOTHING_TO_PAY', message: 'This order has nothing left to pay online.' });
    }
    const payment = await openPayment(order, req).catch((error) => {
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
    return res.json({ paymentStatus: order.paymentStatus, status: order.status });
  } catch (error) { return next(error); }
});

router.get('/mock/checkout', (req, res) => {
  if (paymentMode() !== 'mock') return res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
  const specialReference = String(req.query.ref ?? '');
  const amountCents = Number(req.query.amount_cents);
  if (!referenceFrom(specialReference) || !Number.isInteger(amountCents)) {
    return res.status(400).json({ error: 'INVALID', message: 'Check the request fields.' });
  }
  // Relative on purpose: behind the dev proxy the Host header is the API's, not
  // the page's, and the return page has to stay same-origin with the checkout.
  const link = (success) => `/api/payments/paymob/return?${mockResultQuery({ specialReference, amountCents, success })}`;
  const amount = (amountCents / 100).toLocaleString('en-EG', { minimumFractionDigits: 2 });
  return sendFramePage(res, 200, 'Test payment', `<h1>Test payment</h1>
<p>This stands in for Paymob's page on this computer. No card is charged.<br><strong>${amount} EGP</strong> · ${referenceFrom(specialReference)}</p>
<a class="pay" href="${link(true)}">Pay ${amount} EGP</a>
<a class="decline" href="${link(false)}">Decline the card</a>
<small>PAYMENTS_ONLINE=mock</small>`);
});

export default router;
