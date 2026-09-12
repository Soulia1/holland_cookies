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
    FIREBASE_PROJECT_ID: z.string().min(4).max(120).regex(/^[a-z0-9-]+$/),
    FIREBASE_CLIENT_EMAIL: z.email(),
    // A service account key, not a passphrase. Checked for its actual shape so a
    // truncated or single-line paste fails here rather than at the first query.
    FIREBASE_PRIVATE_KEY: z.string().min(100)
      .refine((v) => v.includes('BEGIN PRIVATE KEY'), 'must be a PEM private key'),

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
}
