/**
 * The server.
 *
 * One Express app serving the API, the storefront and the dashboard from one
 * origin. Same-origin is a deliberate simplification rather than an accident:
 * it means the admin session can be a `SameSite=lax` httpOnly cookie with no
 * CORS preflight and no cross-site exposure to design around.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import 'dotenv/config';

import * as db from './db.js';
import menuRoute from './routes/menu.js';
import ordersRoute from './routes/orders.js';
import adminRoute from './routes/admin.js';
import accountRoute from './routes/account.js';
import { isAdminAuthDisabled } from './adminSession.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/**
 * Whether browsers reach this server over HTTPS.
 *
 * Deliberately its own variable rather than `NODE_ENV === 'production'`, which
 * is what it was and which is a different fact. Two settings depend on it — the
 * CSP's `upgrade-insecure-requests` and the session cookie's `Secure` flag —
 * and both are actively harmful when the origin is plain HTTP: the first
 * rewrites every asset URL to https:// so the page loads with no CSS and no
 * JavaScript, and the second means the browser never sends the session back, so
 * sign-in appears to succeed and every request after it is anonymous.
 *
 * The end-to-end suite runs a production-configured server over http on
 * localhost, which is exactly the combination that made this worth separating.
 */
const httpsOrigin = process.env.HTTPS_ORIGIN !== undefined
  ? process.env.HTTPS_ORIGIN === 'true'
  : process.env.NODE_ENV === 'production';

// Trust the first proxy hop, so req.ip is the client rather than the load
// balancer — without it every request shares one IP and the rate limiters below
// throttle the whole world together.
app.set('trust proxy', 1);

app.use(compression());

app.use(helmet({
  // The storefront and dashboard are bundled with hashed filenames from this
  // same origin, so a strict default is affordable. The exceptions are the two
  // things the pages genuinely need from elsewhere.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Google Fonts serves the stylesheet from one host and the font files
      // from another; both are needed for the Arabic faces.
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      // 'unsafe-inline' for the pre-paint language script in index.html. It is
      // a fixed, authored script rather than anything user-supplied; replacing
      // it with a nonce is the right follow-up once the build can inject one.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      // See `httpsOrigin` above. On a plain-HTTP origin this directive is
      // fatal rather than protective.
      ...(httpsOrigin ? {} : { upgradeInsecureRequests: null }),
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Only relevant when the front end is run from the Vite dev server on another
// port. In production everything is one origin and this matches nothing.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : false,
  credentials: true,
}));

// A cart of sixty lines is a few kilobytes. The cap is what stops an unbounded
// body being parsed before any of our own validation sees it.
app.use(express.json({ limit: '256kb', strict: true }));
app.use(cookieParser());

/**
 * Sign-in is the one endpoint where guessing is the attack: a single shared key
 * and no per-user lockout to hide behind. Tight, and counted per IP.
 */
const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' },
});

/** Placing an order. Generous enough for a real customer, bounded for a script. */
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'RATE_LIMITED', message: 'Too many orders from this connection.' },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api', apiLimiter);
// Only failed/successful sign-in submissions count toward the guessing limit.
// Applying this to every method also throttles the dashboard's harmless
// session-status GET after a few reloads, leaving the key gate permanently
// locked until the window expires.
app.post('/api/admin/session', signInLimiter);
app.post('/api/orders', orderLimiter);

// The API responses are per-request state; caching one would serve one
// customer's order to the next.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/api/menu', menuRoute);
app.use('/api/orders', ordersRoute);
app.use('/api/admin', adminRoute);
app.use('/api/account', accountRoute);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
});

// ------------------------------------------------------------- the pages ----

const dist = path.join(here, '..', 'dist');
const dashboardDist = path.join(here, '..', 'dist-dashboard');

const staticOptions = {
  // Hashed filenames are immutable; index.html is not and must be revalidated
  // or a deploy never reaches anyone with a warm cache.
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    else res.set('Cache-Control', 'public, max-age=31536000, immutable');
  },
};

app.use('/dashboard', express.static(dashboardDist, staticOptions));
app.use(express.static(dist, staticOptions));

// Client-side routing: any non-API path that is not a file is a route the
// browser bundle knows about, so it gets the shell.
app.get('/dashboard/*splat', (_req, res) => {
  res.sendFile(path.join(dashboardDist, 'index.html'));
});
app.get('/*splat', (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'));
});

app.use((error, _req, res, _next) => {
  // Logged in full, returned as a generic message: a stack trace in a response
  // body tells an attacker about the shape of the thing they are attacking.
  console.error('[holland]', error);
  res.status(error.status || 500).json({
    error: error.code || 'SERVER_ERROR',
    message: error.status ? error.message : 'Something went wrong on our end.',
  });
});

const port = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV !== 'test') {
  if (isAdminAuthDisabled()) {
    console.warn('[holland] Admin authentication is disabled for local development.');
  } else if (!process.env.ADMIN_KEY) {
    // Fail loudly at boot rather than at the first sign-in attempt: a server
    // running with no admin key is a dashboard nobody can ever get into.
    console.error('[holland] ADMIN_KEY is not set — the dashboard will be unreachable.');
  }
  db.get();
  app.listen(port, () => {
    console.log(`[holland] listening on http://127.0.0.1:${port}`);
  });
}

export default app;
