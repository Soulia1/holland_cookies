/**
 * The bakery's WhatsApp alert for every new order.
 *
 * A second channel beside the email in `mailer.js`, not a replacement: it says
 * "an order just came in" on the phone that is actually in somebody's hand, and
 * the email stays the detailed, reliable record.
 *
 * The provider is CallMeBot — a free relay that messages one registered number.
 * It is not Meta's Business API, so treat it as a bridge: it has no delivery
 * guarantee and can be throttled. That is why every failure here is swallowed
 * by the caller, and why nothing in the order flow ever depends on it.
 *
 * Two things this must never do, both taken from how the email side is built:
 *
 *  - Stand between a customer and their order. It runs after the order has
 *    committed and is not awaited.
 *  - Send twice for one order. The claim is the reference in the mail log, the
 *    same atomic create the emails use, so it holds even for a caller that
 *    forgets to check `duplicate`.
 *
 * CallMeBot only takes a GET, so the whole message travels in the URL and lands
 * in proxy and provider logs. The alert therefore carries no customer name,
 * phone or address — the reference, the items, the total and a link into the
 * dashboard, which is behind a sign-in.
 */

import { claimMailSend, recordMailSent, releaseMailClaim } from './repo/system.js';
import { money } from './emailTheme.js';
import { orderModel, dashboardOrderUrl } from './mailer.js';

// Pinned in code, like Brevo's: a stray environment variable must not be able
// to redirect an outbound alert.
const CALLMEBOT_URL = 'https://api.callmebot.com/whatsapp.php';

/** The name the shop's phone shows for this message, and its first line. */
const TITLE = 'Online Orders (HC)';

/** Digits with a country code, e.g. `+201210004315`. Spaces and dashes are tolerated. */
export function normalizeWhatsappPhone(value) {
  const compact = String(value || '').replace(/[\s()-]/g, '');
  return /^\+?[1-9]\d{9,14}$/.test(compact) ? `+${compact.replace(/^\+/, '')}` : '';
}

export function whatsappConfigured() {
  return Boolean(normalizeWhatsappPhone(process.env.WHATSAPP_PHONE) && process.env.CALLMEBOT_APIKEY);
}

/** The message body. Exported so the test can pin exactly what would be sent. */
export function whatsappOrderText(order) {
  const model = orderModel(order, false);
  return [
    TITLE,
    `New order ${model.reference}`,
    ...model.lines.map((line) => `${line.qty} x ${line.name}`),
    `Total: ${money(model.total)} (${order.paymentMethod === 'online' ? 'paid online' : 'cash'})`,
    model.delivery ? 'Delivery' : 'Pickup',
    dashboardOrderUrl(order.reference),
  ].join('\n');
}

/**
 * Send the alert for one order.
 *
 * @returns {Promise<{ delivered: boolean, via: string }>}
 * @throws with a `code` when the provider refuses or cannot be reached; the
 *   claim is released first, so a later attempt can still deliver.
 */
export async function sendWhatsappOrderAlert(order) {
  if (!whatsappConfigured()) return { delivered: false, via: 'skipped-not-configured' };

  const key = `whatsapp:${order.reference}`;
  if (!(await claimMailSend(key))) return { delivered: false, via: 'skipped-duplicate' };

  try {
    const url = new URL(CALLMEBOT_URL);
    url.searchParams.set('phone', normalizeWhatsappPhone(process.env.WHATSAPP_PHONE));
    url.searchParams.set('text', whatsappOrderText(order));
    url.searchParams.set('apikey', process.env.CALLMEBOT_APIKEY);

    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const body = await response.text();
    // CallMeBot answers some refusals (bad key, number not registered) with a
    // 200 and an HTML page, so the status alone is not proof.
    if (!response.ok || /error|invalid|not\s+registered|blocked/i.test(body)) {
      const failure = new Error('The WhatsApp provider refused the message.');
      failure.code = 'WHATSAPP_REFUSED';
      throw failure;
    }
    await recordMailSent(key, { to: 'whatsapp', subject: `New order ${order.reference}` });
    return { delivered: true, via: 'callmebot' };
  } catch (error) {
    await releaseMailClaim(key).catch(() => {});
    // A fetch error can quote the URL, which holds the API key. Only a code
    // ever leaves this function.
    const safe = new Error('The WhatsApp alert could not be sent.');
    safe.code = error.code === 'WHATSAPP_REFUSED' ? 'WHATSAPP_REFUSED'
      : error.name === 'TimeoutError' ? 'WHATSAPP_TIMEOUT' : 'WHATSAPP_UNREACHABLE';
    throw safe;
  }
}
