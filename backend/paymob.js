/**
 * Paymob, through its Unified Checkout ("intention") API.
 *
 * The browser never sees a secret and never states an amount. An intention is
 * created here, from the order as the server priced it, and the browser gets a
 * URL to Paymob's own hosted page, which the storefront shows in a popup. Card
 * numbers are typed into Paymob's page, never ours.
 *
 * Whether an order is paid is decided by one thing only: a transaction Paymob
 * signed with the merchant's HMAC secret, arriving either server-to-server (the
 * webhook) or as the query string of the page Paymob sends the popup back to.
 * Both carry the same signature over the same fields, and both are checked here.
 *
 * `PAYMENTS_ONLINE=mock` swaps Paymob for a page this server renders itself, so
 * the whole flow can be run on a laptop before the merchant account has keys.
 * The mock signs its results with the same function real results are verified
 * with; the production config refuses it outright.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Pinned in code so an environment variable cannot redirect payments.
const PAYMOB_BASE = 'https://accept.paymob.com';
const MOCK_HMAC_SECRET = 'local-mock-hmac-secret-not-for-production';

// Paymob's documented order. Changing it, or a single name, breaks every check.
const HMAC_FIELDS = [
  'amount_cents', 'created_at', 'currency', 'error_occured', 'has_parent_transaction',
  'id', 'integration_id', 'is_3d_secure', 'is_auth', 'is_capture', 'is_refunded',
  'is_standalone_payment', 'is_voided', 'order.id', 'owner', 'pending',
  'source_data.pan', 'source_data.sub_type', 'source_data.type', 'success',
];

export const RETURN_PATH = '/api/payments/paymob/return';
export const WEBHOOK_PATH = '/api/payments/paymob/webhook';

export function paymentMode(env = process.env) {
  if (env.PAYMENTS_ONLINE === 'paymob') {
    return env.PAYMOB_SECRET_KEY && env.PAYMOB_PUBLIC_KEY && env.PAYMOB_HMAC_SECRET
      && integrationIds(env).length ? 'paymob' : null;
  }
  if (env.PAYMENTS_ONLINE === 'mock' && env.NODE_ENV !== 'production') return 'mock';
  return null;
}

export const onlinePaymentEnabled = () => paymentMode() !== null;

export function integrationIds(env = process.env) {
  return String(env.PAYMOB_INTEGRATION_IDS ?? '').split(',')
    .map((value) => value.trim()).filter((value) => /^\d{1,12}$/.test(value)).map(Number);
}

const hmacSecret = () => (paymentMode() === 'mock'
  ? (process.env.PAYMOB_HMAC_SECRET || MOCK_HMAC_SECRET)
  : process.env.PAYMOB_HMAC_SECRET);

const text = (value) => (value === undefined || value === null ? '' : String(value));

/** The signature over a transaction, given a lookup from field name to value. */
export function signTransaction(valueOf, secret = hmacSecret()) {
  return createHmac('sha512', secret)
    .update(HMAC_FIELDS.map((field) => text(valueOf(field))).join(''))
    .digest('hex');
}

function sameSignature(expected, received) {
  if (typeof received !== 'string' || !/^[a-f0-9]{128}$/i.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received.toLowerCase(), 'hex'));
}

const nested = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

/** The webhook body's `obj`, as Paymob posts it. */
export function verifyCallback(obj, hmac) {
  if (!obj || typeof obj !== 'object' || !hmacSecret()) return false;
  return sameSignature(signTransaction((field) => nested(obj, field)), hmac);
}

/**
 * The query string Paymob appends when it sends the popup back. Same fields,
 * flattened: `order.id` arrives as `order`, the rest keep their dotted names.
 */
export function verifyRedirect(query) {
  if (!query || !hmacSecret()) return false;
  const valueOf = (field) => query[field === 'order.id' ? 'order' : field];
  return sameSignature(signTransaction(valueOf), query.hmac);
}

const flag = (value) => value === true || value === 'true';

/** One shape for both arrival routes, so a single function records the result. */
export function transactionFromCallback(obj) {
  return {
    id: text(obj.id),
    success: flag(obj.success),
    pending: flag(obj.pending),
    amountCents: Number(obj.amount_cents),
    currency: text(obj.currency),
    merchantOrderId: text(obj.order?.merchant_order_id),
    paymobOrderId: text(obj.order?.id),
    followUp: flag(obj.has_parent_transaction) || flag(obj.is_refunded) || flag(obj.is_voided),
    method: text(obj.source_data?.type),
  };
}

export function transactionFromRedirect(query) {
  return {
    id: text(query.id),
    success: flag(query.success),
    pending: flag(query.pending),
    amountCents: Number(query.amount_cents),
    currency: text(query.currency),
    merchantOrderId: text(query.merchant_order_id),
    paymobOrderId: text(query.order),
    followUp: flag(query.has_parent_transaction) || flag(query.is_refunded) || flag(query.is_voided),
    method: text(query['source_data.type']),
  };
}

/** Each intention's reference is `HC-123-xxxxxx`; the order is the `HC-123` part. */
export function referenceFrom(merchantOrderId) {
  return /^(HC-\d{1,16})(?:-[a-z0-9]+)?$/i.exec(String(merchantOrderId ?? ''))?.[1]?.toUpperCase() ?? null;
}

export const toCents = (pounds) => Math.round(Number(pounds) * 100);

/** Egypt's local mobile format, which the orders store, as E.164. */
const e164 = (phone) => (/^0\d{10}$/.test(phone) ? `+2${phone}` : phone);

function providerError(message) {
  const error = new Error(message);
  error.code = 'PAYMENT_PROVIDER';
  return error;
}

/**
 * Open a payment for an order: returns the URL the popup loads.
 *
 * A fresh intention every time, with its own suffix, because Paymob refuses a
 * reused `special_reference` and a customer who closed the popup, or whose card
 * was declined, has to be able to try again.
 */
export async function createCheckoutSession(order, { origin }) {
  const mode = paymentMode();
  if (!mode) throw providerError('Online payment is not configured.');
  const specialReference = `${order.reference}-${randomBytes(4).toString('hex')}`;
  const amountCents = toCents(order.total);
  const returnUrl = `${origin}${RETURN_PATH}`;

  if (mode === 'mock') {
    const params = new URLSearchParams({ ref: specialReference, amount_cents: String(amountCents) });
    return {
      checkoutUrl: `${origin}/api/payments/mock/checkout?${params}`,
      intentionId: `mock_${specialReference}`,
      paymobOrderId: '',
      specialReference,
    };
  }

  const firstName = order.firstName || 'Customer';
  const response = await fetch(`${PAYMOB_BASE}/v1/intention/`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.PAYMOB_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      amount: amountCents,
      currency: 'EGP',
      payment_methods: integrationIds(),
      // One line for the whole order: Paymob refuses an intention whose items
      // do not add up to its amount, and ours carries a discount and a fee.
      items: [{
        name: `Holland Cookies ${order.reference}`,
        amount: amountCents,
        description: `Order ${order.reference}`,
        quantity: 1,
      }],
      billing_data: {
        first_name: firstName,
        last_name: order.lastName || 'NA',
        phone_number: e164(order.phone),
        email: order.email,
        street: order.address || 'NA',
        building: order.building || 'NA',
        floor: order.floor || 'NA',
        apartment: order.apartment || 'NA',
        city: order.area || 'Cairo',
        state: 'NA',
        country: 'EG',
      },
      customer: { first_name: firstName, last_name: order.lastName || 'NA', email: order.email },
      special_reference: specialReference,
      expiration: 3600,
      notification_url: `${process.env.APP_ORIGIN || origin}${WEBHOOK_PATH}`,
      redirection_url: returnUrl,
    }),
  }).catch(() => { throw providerError('Paymob could not be reached.'); });

  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.client_secret !== 'string') {
    // The status only: Paymob's error body can echo the customer's details.
    throw providerError(`Paymob refused the intention (HTTP ${response.status}).`);
  }
  const params = new URLSearchParams({
    publicKey: process.env.PAYMOB_PUBLIC_KEY, clientSecret: body.client_secret,
  });
  return {
    checkoutUrl: `${PAYMOB_BASE}/unifiedcheckout/?${params}`,
    intentionId: text(body.id),
    paymobOrderId: text(body.intention_order_id),
    specialReference,
  };
}

/**
 * The mock's result links: exactly the query string Paymob would send back,
 * signed the same way, so the return handler cannot tell them apart.
 */
export function mockResultQuery({ specialReference, amountCents, success }) {
  const fields = {
    amount_cents: String(amountCents),
    created_at: new Date().toISOString(),
    currency: 'EGP',
    error_occured: 'false',
    has_parent_transaction: 'false',
    id: String(Date.now()),
    integration_id: '0',
    is_3d_secure: 'true',
    is_auth: 'false',
    is_capture: 'false',
    is_refunded: 'false',
    is_standalone_payment: 'true',
    is_voided: 'false',
    order: '0',
    owner: '0',
    pending: 'false',
    'source_data.pan': '2346',
    'source_data.sub_type': 'MasterCard',
    'source_data.type': 'card',
    success: success ? 'true' : 'false',
    merchant_order_id: specialReference,
  };
  const hmac = signTransaction((field) => fields[field === 'order.id' ? 'order' : field]);
  return new URLSearchParams({ ...fields, hmac }).toString();
}
