import { z } from 'zod';

/**
 * Production configuration, checked once at boot.
 *
 * This runs before the server listens, so a misconfigured production deploy
 * fails to start rather than starting and being subtly wrong — an admin key of
 * `change-me` that nobody notices is worse than a container that will not boot.
 *
 * The Firestore migration replaced the two filesystem variables (DATABASE_PATH,
 * DATA_VOLUME_PATH, and the check that one was inside the other) with the
 * service account triple. Everything else is unchanged.
 */
export function validateEnvironment(env = process.env) {
  if (env.NODE_ENV !== 'production') return;

  const secret = z.string().min(32).max(200)
    .refine((v) => !/(change-me|example|e2e-|benchmark|test-secret)/i.test(v));

  const parsed = z.object({
    ADMIN_KEY: secret,
    JWT_SECRET: secret,
    APP_ORIGIN: z.url().refine((v) => new URL(v).protocol === 'https:' && new URL(v).origin === v),

    // --- Firestore -----------------------------------------------------------
    // Credentials are checked below rather than here, because there are three
    // valid shapes and a zod object cannot express "exactly one of these".
    FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
    FIREBASE_PROJECT_ID: z.string().min(4).max(120).regex(/^[a-z0-9-]+$/).optional(),
    FIREBASE_CLIENT_EMAIL: z.email().optional(),
    FIREBASE_PRIVATE_KEY: z.string().min(100).optional(),

    // Belt and braces against the worst possible misconfiguration: a production
    // process pointed at an emulator would accept orders into a database that
    // evaporates on restart. `.optional()` is load-bearing — a bare
    // `z.undefined()` is still a *required* key in a zod object and would fail
    // every environment, set or not.
    FIRESTORE_EMULATOR_HOST: z.undefined().optional(),

    BREVO_API_KEY: z.string().min(20),
    MAIL_FROM_EMAIL: z.email(),
    DEPLOYMENT_MODE: z.literal('single-instance'),
    HTTPS_ORIGIN: z.literal('true').optional(),
    MAIL_TRANSPORT: z.literal('brevo').optional(),
    DISABLE_ADMIN_AUTH: z.enum(['false', '']).optional(),
    ALLOWED_ORIGINS: z.literal('').optional(),
    // The mail client's base URL is pinned in code so a stray environment
    // variable cannot redirect outbound mail.
    BREVO_BASE_URL: z.undefined().optional(),
  }).safeParse(env);

  if (!parsed.success) {
    throw new Error(`Invalid production configuration: ${[...new Set(parsed.error.issues.map((i) => i.path[0]))].join(', ')}`);
  }
  if (env.ADMIN_KEY === env.JWT_SECRET) throw new Error('Production secrets must be independent');

  assertFirebaseCredentials(env);
}

/**
 * Exactly one usable set of Firebase credentials must be present.
 *
 * Checked here as well as in `firestore.js` so a bad credential fails at boot
 * rather than on the first request that happens to touch the database — which
 * for a shop is the first customer, not the deploy.
 *
 * The service-account file is not consulted: production runs from an
 * environment variable, and a key file sitting on a production container is a
 * separate problem.
 */
function assertFirebaseCredentials(env) {
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let parsed;
    try {
      parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    for (const field of ['project_id', 'client_email', 'private_key']) {
      if (!parsed[field]) throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is missing ${field}`);
    }
    if (!String(parsed.private_key).includes('BEGIN PRIVATE KEY')) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON private_key is not a PEM key');
    }
    return;
  }

  const trio = [env.FIREBASE_PROJECT_ID, env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY];
  if (trio.every(Boolean)) {
    if (!env.FIREBASE_PRIVATE_KEY.includes('BEGIN PRIVATE KEY')) {
      throw new Error('FIREBASE_PRIVATE_KEY is not a PEM private key');
    }
    return;
  }

  throw new Error(
    'Invalid production configuration: no Firebase credentials. Set '
    + 'FIREBASE_SERVICE_ACCOUNT_JSON to the contents of the service account key '
    + '(preferred), or all three of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL '
    + 'and FIREBASE_PRIVATE_KEY.',
  );
}
