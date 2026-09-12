/**
 * Check that Brevo is actually configured and will actually send.
 *
 *   node scripts/mail-check.mjs you@example.com
 *
 * There is no way to know a mail provider works except by asking it to send
 * something, and the failure mode this guards against is the quiet one: a key
 * that authenticates fine but a sender address the account has not verified, so
 * every message is accepted by the API and delivered to nobody. That returns a
 * perfectly happy 201 and produces silence.
 *
 * So this reports what was accepted AND tells you to go and look in the inbox,
 * because only the second half is proof.
 *
 * Reads `.env` like the server does. Sends one real email — it costs one send
 * against the account quota.
 */

import 'dotenv/config';

const [, , recipient] = process.argv;

const fail = (message) => { console.error(`\n  ✖ ${message}\n`); process.exit(1); };

if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient)) {
  fail('Usage: node scripts/mail-check.mjs <recipient@example.com>');
}

const key = process.env.BREVO_API_KEY;
const from = process.env.MAIL_FROM_EMAIL;

console.log('\n  Brevo configuration');
console.log(`    BREVO_API_KEY    ${key ? `set (${key.length} chars, ${key.slice(0, 8)}…)` : 'MISSING'}`);
console.log(`    MAIL_FROM_EMAIL  ${from || 'MISSING'}`);
console.log(`    MAIL_FROM_NAME   ${process.env.MAIL_FROM_NAME || '(defaults to "Holland Cookies")'}`);
console.log(`    MAIL_REPLY_TO    ${process.env.MAIL_REPLY_TO || '(none)'}`);

if (!key) fail('BREVO_API_KEY is not set. Put it in .env, then run this again.');
if (!from) fail('MAIL_FROM_EMAIL is not set. It must be a sender Brevo has verified.');

// Ask Brevo who we are before sending. This separates "the key is wrong" from
// "the send was rejected", which are different problems with different fixes.
const account = await fetch('https://api.brevo.com/v3/account', {
  headers: { 'api-key': key, accept: 'application/json' },
  signal: AbortSignal.timeout(10000),
}).catch((error) => fail(`Could not reach Brevo: ${error.message}`));

if (account.status === 401) fail('Brevo rejected the API key (401). Check BREVO_API_KEY.');
if (!account.ok) fail(`Brevo returned ${account.status} for /v3/account.`);

const who = await account.json();
console.log(`\n  Authenticated as ${who.email ?? '(unknown)'}${who.companyName ? ` — ${who.companyName}` : ''}`);
if (who.plan?.[0]) {
  const plan = who.plan[0];
  console.log(`    plan: ${plan.type ?? '?'}${plan.credits !== undefined ? `, credits ${plan.credits}` : ''}`);
}

// The senders the account will actually accept a From address from.
const senders = await fetch('https://api.brevo.com/v3/senders', {
  headers: { 'api-key': key, accept: 'application/json' },
  signal: AbortSignal.timeout(10000),
});
if (senders.ok) {
  const list = (await senders.json()).senders ?? [];
  const match = list.find((s) => s.email?.toLowerCase() === from.toLowerCase());
  console.log(`\n  Verified senders (${list.length}):`);
  for (const s of list) console.log(`    ${s.active ? '✓' : '✗'} ${s.email}`);
  if (!match) {
    fail(`MAIL_FROM_EMAIL (${from}) is not among them. Brevo will reject or silently drop the send.\n`
      + '    Add and verify it at https://app.brevo.com/senders');
  }
  if (!match.active) fail(`${from} is listed but not active. Finish verifying it in Brevo.`);
  console.log(`\n  ✓ ${from} is a verified, active sender.`);
} else {
  console.log('\n  (could not list senders — continuing anyway)');
}

// Now the real thing, through the application's own mailer rather than a
// hand-rolled request, so this exercises the code the server actually runs.
const { sendMail } = await import('../backend/mailer.js');

console.log(`\n  Sending a test message to ${recipient} …`);
try {
  const result = await sendMail({
    to: recipient,
    subject: 'Holland Cookies — mail check',
    text: 'If you are reading this, Brevo is wired up correctly.\n\n'
      + 'Sent by scripts/mail-check.mjs. Nothing else was changed.',
    html: '<div style="font-family:system-ui,sans-serif">'
      + '<p style="font-size:14px;color:#5d101d;font-weight:600;letter-spacing:.12em;'
      + 'text-transform:uppercase">Holland Cookies</p>'
      + '<p>If you are reading this, Brevo is wired up correctly.</p>'
      + '<p style="font-size:13px;color:#777">Sent by <code>scripts/mail-check.mjs</code>.</p></div>',
  });
  console.log(`  ✓ Accepted by ${result.via} (delivered=${result.delivered}).`);
} catch (error) {
  fail(`Send failed: ${error.code ?? 'UNKNOWN'} — ${error.message}`);
}

console.log('\n  Accepted is not delivered. Go and look in the inbox, and in spam.');
console.log('  If it never arrives, the sender domain almost certainly needs SPF/DKIM:');
console.log('  https://app.brevo.com/senders/domain/list\n');
