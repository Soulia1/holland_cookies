/**
 * Paymob, through its Unified Checkout ("intention") API.
 *
 * The browser never sees a merchant secret and never states an amount. An intention is
 * created here, from the order as the server priced it, and the browser gets a
 * URL to Paymob's own hosted page, which the storefront navigates to. Card
 * numbers are typed into Paymob's page, never ours.
 *
 * Whether an order is paid is decided by one thing only: a transaction Paymob
 * signed with the merchant's HMAC secret and arriving server-to-server. The
 * browser return is also signed, but provides navigation and result hints only.
 *
 * `PAYMENTS_ONLINE=mock` swaps Paymob for a page this server renders itself, so
 * the whole flow can be run on a laptop before the merchant account has keys.
 * The mock signs its results with the same function real results are verified
 * with; the production config refuses it outright.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Pinned in code so an environment variable cannot redirect payments.
const PAYMOB_BASE = 'https://accept.paymob.com';
const CHECKOUT_BASE = 'https://eg.checkout.paymob.com/';
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
  const ids = String(env.PAYMOB_INTEGRATION_IDS ?? '').split(',')
    .map((value) => value.trim()).filter((value) => /^\d{1,12}$/.test(value)).map(Number);
  if (env.PAYMOB_CARD_INTEGRATION_ID && /^\d{1,12}$/.test(env.PAYMOB_CARD_INTEGRATION_ID.trim())) {
    const cardId = Number(env.PAYMOB_CARD_INTEGRATION_ID.trim());
    if (!ids.includes(cardId)) ids.push(cardId);
  }
  if (env.PAYMOB_WALLET_INTEGRATION_ID && /^\d{1,12}$/.test(env.PAYMOB_WALLET_INTEGRATION_ID.trim())) {
    const walletId = Number(env.PAYMOB_WALLET_INTEGRATION_ID.trim());
    if (!ids.includes(walletId)) ids.push(walletId);
  }
  return [...new Set(ids)];
}

export function cardIntegrationId(env = process.env) {
  if (env.PAYMOB_CARD_INTEGRATION_ID && /^\d{1,12}$/.test(env.PAYMOB_CARD_INTEGRATION_ID.trim())) {
    return Number(env.PAYMOB_CARD_INTEGRATION_ID.trim());
  }
  const ids = integrationIds(env);
  return ids[0] ?? null;
}

export function walletIntegrationId(env = process.env) {
  if (env.PAYMOB_WALLET_INTEGRATION_ID && /^\d{1,12}$/.test(env.PAYMOB_WALLET_INTEGRATION_ID.trim())) {
    return Number(env.PAYMOB_WALLET_INTEGRATION_ID.trim());
  }
  // Integration order does not identify a gateway. Never use a card ID for wallets.
  return null;
}

export function walletPaymentEnabled(env = process.env) {
  const mode = paymentMode(env);
  if (!mode) return false;
  if (mode === 'mock') return true;
  return Boolean(walletIntegrationId(env) && walletIntegrationId(env) !== cardIntegrationId(env));
}

export function methodsFor(method, env = process.env) {
  if (method === 'wallet') {
    const wId = walletIntegrationId(env);
    return walletPaymentEnabled(env) && wId ? [wId] : [];
  }
  if (method === 'card') {
    const cId = cardIntegrationId(env);
    return cId ? [cId] : integrationIds(env);
  }
  return integrationIds(env);
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
 * The query string Paymob appends when it sends the browser back. Same fields,
 * flattened: `order.id` arrives as `order`, the rest keep their dotted names.
 */
export function verifyRedirect(query) {
  if (!query || !hmacSecret()) return false;
  if (query.order && query.order_id && query.order !== query.order_id) return false;
  const valueOf = (field) => field === 'order.id' ? (query.order ?? query.order_id) : query[field];
  return sameSignature(signTransaction(valueOf), query.hmac);
}

const flag = (value) => value === true || value === 'true';

/** One shape for both arrival routes, so a single function records the result. */
export function transactionFromCallback(obj) {
  return {
    id: text(obj.id),
    success: flag(obj.success),
    pending: flag(obj.pending),
    error: flag(obj.error_occured),
    auth: flag(obj.is_auth),
    integrationId: Number(obj.integration_id),
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
    error: flag(query.error_occured),
    auth: flag(query.is_auth),
    integrationId: Number(query.integration_id),
    amountCents: Number(query.amount_cents),
    currency: text(query.currency),
    merchantOrderId: text(query.merchant_order_id),
    paymobOrderId: text(query.order ?? query.order_id),
    followUp: flag(query.has_parent_transaction) || flag(query.is_refunded) || flag(query.is_voided),
    method: text(query['source_data.type']),
  };
}

/** Each intention's reference is `HC-123-xxxxxx`; the order is the `HC-123` part. */
export function referenceFrom(merchantOrderId) {
  return /^(HC-\d{1,16})(?:-[a-z0-9]+)?$/i.exec(String(merchantOrderId ?? ''))?.[1]?.toUpperCase() ?? null;
}

export const toCents = (pounds) => Math.round(Number(pounds) * 100);

/** Refund totals are not covered by Paymob's HMAC. Read them from its API. */
export async function retrieveTransaction(transactionId) {
  if (!process.env.PAYMOB_API_KEY || !/^\d{1,20}$/.test(String(transactionId))) {
    throw providerError('Paymob transaction inquiry is not configured.');
  }
  const request = async (path, init) => {
    const response = await fetch(`${PAYMOB_BASE}${path}`, {
      ...init, signal: AbortSignal.timeout(5_000), redirect: 'error',
    }).catch(() => { throw providerError('Paymob could not be reached.'); });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body) throw providerError(`Paymob inquiry failed (HTTP ${response.status}).`);
    return body;
  };
  const { token } = await request('/api/auth/tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.PAYMOB_API_KEY }),
  });
  if (typeof token !== 'string' || !token) throw providerError('Paymob returned no auth token.');
  const read = (id) => request(`/api/acceptance/transactions/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let obj = await read(transactionId);
  // A child refund/void refers to the original charge. Both reads are authenticated.
  if (flag(obj.has_parent_transaction)) {
    const parent = typeof obj.parent_transaction === 'object' ? obj.parent_transaction?.id : obj.parent_transaction;
    if (!/^\d{1,20}$/.test(String(parent))) throw providerError('Paymob returned no original transaction.');
    obj = await read(parent);
  }
  const txn = transactionFromCallback(obj);
  return {
    ...txn, followUp: false, verifiedInquiry: true,
    refundedCents: Number(obj.refunded_amount_cents ?? 0),
    voided: flag(obj.is_voided),
  };
}

/** Egypt's local mobile format, which the orders store, as E.164. */
const e164 = (phone) => (/^0\d{10}$/.test(phone) ? `+2${phone}` : phone);

function providerError(message) {
  const error = new Error(message);
  error.code = 'PAYMENT_PROVIDER';
  return error;
}

/**
 * Open a payment for an order: returns the hosted checkout URL.
 *
 * A fresh intention every time, with its own suffix, because Paymob refuses a
 * reused `special_reference` and a customer who left checkout, or whose card
 * was declined, has to be able to try again.
 */
export async function createCheckoutSession(order, { origin, method }) {
  const mode = paymentMode();
  if (!mode) throw providerError('Online payment is not configured.');
  const chosenMethod = method || order.onlineMethod || 'all';
  if (chosenMethod === 'wallet' && !walletPaymentEnabled()) {
    throw providerError('Mobile wallet payment is not configured.');
  }
  const specialReference = `${order.reference}-${randomBytes(4).toString('hex')}`;
  const amountCents = toCents(order.total);
  const returnUrl = `${origin}${RETURN_PATH}`;

  if (mode === 'mock') {
    const params = new URLSearchParams({
      ref: specialReference,
      amount_cents: String(amountCents),
      method: chosenMethod,
    });
    return {
      checkoutUrl: `${origin}/api/payments/mock/checkout?${params}`,
      intentionId: `mock_${specialReference}`,
      paymobOrderId: specialReference,
      specialReference,
    };
  }

  const firstName = order.firstName || 'Customer';
  const response = await fetch(`${PAYMOB_BASE}/v1/intention/`, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Token ${process.env.PAYMOB_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      amount: amountCents,
      currency: 'EGP',
      // Unified Checkout owns the picker: offer every configured gateway even
      // when the customer expressed a preference on the shop's checkout.
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
  if (!response.ok || typeof body.client_secret !== 'string' || !body.client_secret
      || !body.id || !body.intention_order_id) {
    // The status only: Paymob's error body can echo the customer's details.
    throw providerError(`Paymob refused the intention (HTTP ${response.status}).`);
  }
  const params = new URLSearchParams({
    publicKey: process.env.PAYMOB_PUBLIC_KEY, clientSecret: body.client_secret,
  });
  return {
    checkoutUrl: `${CHECKOUT_BASE}?${params}`,
    intentionId: text(body.id),
    paymobOrderId: text(body.intention_order_id),
    specialReference,
  };
}

/**
 * The mock's result links: exactly the query string Paymob would send back,
 * signed the same way, so the return handler cannot tell them apart.
 */
export function mockResultQuery({ specialReference, amountCents, success, method = 'card' }) {
  const isWallet = method === 'wallet';
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
    order: specialReference,
    owner: '0',
    pending: 'false',
    'source_data.pan': isWallet ? '01012345678' : '2346',
    'source_data.sub_type': isWallet ? 'Vodafone Cash' : 'MasterCard',
    'source_data.type': isWallet ? 'wallet' : 'card',
    success: success ? 'true' : 'false',
    merchant_order_id: specialReference,
  };
  const hmac = signTransaction((field) => fields[field === 'order.id' ? 'order' : field]);
  return new URLSearchParams({ ...fields, hmac }).toString();
}
