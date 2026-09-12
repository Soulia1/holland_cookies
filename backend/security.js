import { createHmac, randomUUID } from 'node:crypto';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import {
  incrementRateLimit, decrementRateLimit, resetRateLimit, purgeExpiredRateLimits,
} from './repo/system.js';

/**
 * Rate limiting.
 *
 * ## Two stores, on purpose
 *
 * The SQLite version put every limiter class in the database, which was free —
 * a local file, a synchronous write, no network. Firestore is neither free nor
 * local: every counter increment is a transaction over the wire, billed as a
 * read and a write, adding latency to the request it is protecting.
 *
 * Putting the public read limiter (300 requests per minute per IP, on the
 * busiest endpoints in the system) into Firestore would mean a Firestore
 * transaction on *every page load of the shop*. That is the single most
 * expensive thing this migration could do, and it would buy almost nothing: the
 * public limiter exists to blunt scraping, and a counter that resets when the
 * process restarts still blunts scraping.
 *
 * So the classes are split by what durability is actually worth to them:
 *
 *   DURABLE (Firestore) — sign-in, checkout, promo validation, one-time codes,
 *   admin writes. These are the limits where the attack is *guessing*, where the
 *   attacker controls the restart timing precisely because a crash-loop is
 *   something they can sometimes cause, and where a few extra milliseconds do
 *   not matter. A limit that forgets is not a limit here.
 *
 *   IN-MEMORY (express-rate-limit's default store) — public catalogue reads.
 *   High volume, low stakes, nothing secret behind them.
 *
 * ## Multi-instance
 *
 * `DEPLOYMENT_MODE=single-instance` is enforced in production config, and the
 * in-memory half of this is why. If Holland ever runs more than one instance,
 * the public limiter becomes per-instance (acceptable — it degrades to a looser
 * limit) but nothing else changes, because the strict classes are already shared
 * through Firestore. That is the specific property that makes this split safe to
 * scale into rather than a decision that has to be revisited under load.
 */

/** Counter namespaces that must survive a restart. Everything else is in-memory. */
const DURABLE = new Set([
  'login', 'checkout', 'coupon', 'otp-request', 'otp-verify', 'admin-write', 'tracking',
]);

let lastPurge = 0;
const PURGE_INTERVAL_MS = 60 * 1000;

/**
 * A Firestore-backed counter store for express-rate-limit.
 *
 * Keys are HMAC'd before they become document ids: the raw key is a client IP,
 * and an IP address is personal data that does not need to be sitting in a
 * database in the clear to count requests.
 */
export class FirestoreRateStore {
  localKeys = false;

  constructor(namespace) {
    this.namespace = namespace;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  key(key) {
    return createHmac('sha256', process.env.JWT_SECRET || 'local-limiter')
      .update(`${this.namespace}:${key}`).digest('hex');
  }

  async increment(key) {
    if (Date.now() - lastPurge > PURGE_INTERVAL_MS) {
      lastPurge = Date.now();
      purgeExpiredRateLimits().catch(() => {});
    }
    return incrementRateLimit(this.key(key), this.windowMs);
  }

  async decrement(key) {
    await decrementRateLimit(this.key(key));
  }

  async resetKey(key) {
    await resetRateLimit(this.key(key));
  }
}

export function limit(namespace, windowMs, max) {
  return rateLimit({
    windowMs,
    limit: max,
    ...(DURABLE.has(namespace) ? { store: new FirestoreRateStore(namespace) } : {}),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler(req, res) {
      logEvent('rate_limited', req, { class: namespace });
      res.status(429).json({ error: 'RATE_LIMITED', message: 'Too many requests. Try again later.' });
    },
  });
}

export function logEvent(event, req, extra = {}) {
  console.info(JSON.stringify({
    time: new Date().toISOString(), event, requestId: req?.requestId, ...extra,
  }));
}

export function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  const start = performance.now();
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api/')) {
      logEvent('request', req, {
        method: req.method,
        route: req.route?.path || 'unmatched',
        status: res.statusCode,
        durationMs: Math.round(performance.now() - start),
      });
    }
  });
  next();
}

/**
 * Origin checking — the CSRF defence.
 *
 * Cookies are `SameSite` already, but SameSite is a browser behaviour and this
 * is a server-side refusal, which is the layer that does not depend on the
 * client being well-behaved or up to date.
 *
 * The `x-requested-with` requirement covers requests that carry no Origin at
 * all. A custom header forces a CORS preflight for anything cross-site, so a
 * form post or an image tag from another origin cannot set it.
 */
export function originGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const expected = process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
  const permitted = [expected, ...(process.env.NODE_ENV === 'production'
    ? [] : (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean))];
  const validOrigin = origin && permitted.includes(origin);

  if ((origin && !validOrigin) || req.get('sec-fetch-site') === 'cross-site'
    || (!origin && req.get('x-requested-with') !== 'Holland')) {
    logEvent('origin_rejected', req);
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Request origin was not accepted.' });
  }
  return next();
}

export { DURABLE };
