import { createHash, timingSafeEqual } from 'node:crypto';
import { createSession, readStoredSession, revokeSession, cookieOptions } from './sessionStore.js';
import { logEvent } from './security.js';
import { appendAuditEvent } from './repo/system.js';

const SESSION_COOKIE = 'holland_admin_session';
const TTL = 12 * 60 * 60;

const digest = (value) => createHash('sha256').update(value).digest();

/**
 * Compare the supplied key against the configured one in constant time.
 *
 * Both sides are hashed first so `timingSafeEqual` gets two equal-length
 * buffers — it throws otherwise, and the length of the thrown-versus-returned
 * path would itself leak the length of the real key.
 */
export function matchesMasterKey(supplied) {
  const configured = process.env.ADMIN_KEY;
  return typeof supplied === 'string' && supplied.length <= 200 && !!configured
    && timingSafeEqual(digest(supplied), digest(configured));
}

export async function issueSession(res) {
  const token = await createSession('admin', 'admin', TTL);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(TTL), sameSite: 'strict' });
  return token;
}

export async function clearSession(res, req) {
  await revokeSession(req?.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(0), sameSite: 'strict' });
}

export async function readSession(req) {
  const session = await readStoredSession(req.cookies?.[SESSION_COOKIE], 'admin');
  return session ? { subject: 'admin' } : null;
}

/**
 * The admin gate.
 *
 * Every admin route mounts this independently. Hiding a button in the dashboard
 * is not security; this is the thing that actually refuses, and it refuses
 * before any handler runs.
 *
 * Note what it does NOT rely on: Firestore security rules. The server uses the
 * Admin SDK, which bypasses rules entirely, so authorization has to be enforced
 * here or it is not enforced at all. See the comment at the top of
 * firestore.rules.
 */
export async function requireAdmin(req, res, next) {
  try {
    const session = await readSession(req);
    if (!session) {
      logEvent('authorization_denied', req, { role: 'admin' });
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Admin sign-in required.' });
    }
    req.admin = session;

    if (!['GET', 'HEAD'].includes(req.method)) {
      // Record intent before mutation. Successful status changes also append
      // their own event atomically with status/history.
      await appendAuditEvent({
        actor: 'admin',
        action: `${req.method}:attempt`,
        resource: req.route?.path || 'admin',
        requestId: req.requestId || '',
      });
      res.on('finish', () => logEvent('admin_write', req, { method: req.method, status: res.statusCode }));
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

export { SESSION_COOKIE };
