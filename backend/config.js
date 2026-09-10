import path from 'node:path';
import { z } from 'zod';
export function validateEnvironment(env=process.env) {
  if(env.NODE_ENV!=='production') return;
  const secret=z.string().min(32).max(200).refine(v=>!/(change-me|example|e2e-|benchmark|test-secret)/i.test(v));
  const parsed=z.object({
    ADMIN_KEY:secret, JWT_SECRET:secret,
    APP_ORIGIN:z.url().refine(v=>new URL(v).protocol==='https:' && new URL(v).origin===v),
    DATABASE_PATH:z.string().min(1).refine(v=>path.isAbsolute(v)),
    DATA_VOLUME_PATH:z.string().min(1).refine(v=>path.isAbsolute(v)),
    BREVO_API_KEY:z.string().min(20), MAIL_FROM_EMAIL:z.email(),
    DEPLOYMENT_MODE:z.literal('single-instance'),
    HTTPS_ORIGIN:z.literal('true').optional(),
    MAIL_TRANSPORT:z.literal('brevo').optional(),
    DISABLE_ADMIN_AUTH:z.enum(['false','']).optional(),
    ALLOWED_ORIGINS:z.literal('').optional(),
    // `.optional()` is load-bearing, not decoration. The intent here is "this
    // must not be set" — the mail client's base URL is pinned in code so a
    // stray environment variable cannot redirect outbound mail. But a bare
    // `z.undefined()` is *required* in a zod object, and a missing key fails it
    // exactly as a set one does, so this rejected every possible environment
    // and the server could never boot in production however it was configured.
    // Optional passes when absent and still fails when present, which is the
    // rule that was meant.
    BREVO_BASE_URL:z.undefined().optional(),
  }).safeParse(env);
  if(!parsed.success) throw new Error(`Invalid production configuration: ${[...new Set(parsed.error.issues.map(i=>i.path[0]))].join(', ')}`);
  if(env.ADMIN_KEY===env.JWT_SECRET) throw new Error('Production secrets must be independent');
  const relative=path.relative(env.DATA_VOLUME_PATH,env.DATABASE_PATH);
  if(!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('DATABASE_PATH must be inside DATA_VOLUME_PATH');
}
