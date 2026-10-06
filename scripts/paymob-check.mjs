import 'dotenv/config';
import { paymentMode, integrationIds, walletPaymentEnabled, walletIntegrationId, RETURN_PATH, WEBHOOK_PATH } from '../backend/paymob.js';

const required = ['PAYMOB_SECRET_KEY', 'PAYMOB_PUBLIC_KEY', 'PAYMOB_HMAC_SECRET', 'PAYMOB_INTEGRATION_IDS', 'PAYMOB_API_KEY'];
const missing = required.filter((key) => !process.env[key]?.trim());
const problems = [];
if (process.env.PAYMENTS_ONLINE !== 'paymob') problems.push('Set PAYMENTS_ONLINE=paymob.');
if (missing.length) problems.push(`Missing: ${missing.join(', ')}.`);
if (!integrationIds().length) problems.push('Set numeric, comma-separated payment integration IDs.');
let origin;
try {
  const url = new URL(process.env.APP_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== process.env.APP_ORIGIN) throw new Error();
  origin = url.origin;
} catch { problems.push('APP_ORIGIN must be the public HTTPS shop origin without a trailing slash.'); }
const secretMode = /egy_sk_(test|live)_/.exec(process.env.PAYMOB_SECRET_KEY ?? '')?.[1];
const publicMode = /egy_pk_(test|live)_/.exec(process.env.PAYMOB_PUBLIC_KEY ?? '')?.[1];
if (secretMode && publicMode && secretMode !== publicMode) problems.push('Public and secret keys must use the same test/live mode.');
console.log(JSON.stringify({
  configured: problems.length === 0 && paymentMode() === 'paymob',
  mode: secretMode ?? 'unknown',
  integrationIds: integrationIds(),
  walletConfigured: walletPaymentEnabled(),
  walletIntegrationId: walletIntegrationId(),
  ...(origin ? { webhook: `${origin}${WEBHOOK_PATH}`, returnUrl: `${origin}${RETURN_PATH}` } : {}),
  problems,
}, null, 2));
if (problems.length) process.exitCode = 1;
else if (process.argv.includes('--provider')) {
  try {
    const response = await fetch('https://accept.paymob.com/api/auth/tokens', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.PAYMOB_API_KEY }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.token !== 'string') throw new Error(`HTTP ${response.status}`);
    console.log('Paymob API authentication succeeded. No payment was created or charged.');
  } catch {
    console.error('Paymob API authentication failed. Check the API key and network access.');
    process.exitCode = 1;
  }
}
