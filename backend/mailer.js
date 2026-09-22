/**
 * Sending mail.
 *
 * One transport interface with one real implementation — Brevo — plus a
 * development fallback that writes the message to the server log.
 *
 * Email is deliberately NOT part of the launch. Brevo activates only when
 * `MAIL_TRANSPORT=brevo` is set explicitly alongside `BREVO_API_KEY`; a key left
 * behind in an environment on its own sends nothing. Until then no order
 * confirmation is sent and customer sign-in (which needs an emailed code) is
 * switched off — see `accountsAvailable`.
 *
 * Four kinds of message are sent:
 *
 *   - the sign-in code, to a customer signing in;
 *   - the order confirmation, to the customer who ordered;
 *   - the new-order alert, to the bakery (ADMIN_ORDER_EMAIL);
 *   - a milestone update when an order goes out and when it arrives.
 *
 * Only two milestones are announced. Holland's statuses are fulfilment-neutral
 * — `in_transit` reads "Out for delivery" or "Ready for pickup" and `completed`
 * reads "Delivered" or "Picked up" — so those two statuses produce the four
 * messages a customer can receive, and the earlier internal moves produce none.
 * A mail for every step would be noise, and noise is what gets a sender blocked.
 *
 * Every send that must not repeat goes through `sendOnce`, which claims its
 * dedupe key in the mail log before the provider is called.
 *
 * The three things it must never do:
 *
 *  - Resolve successfully in production when nothing was sent. A sign-in code
 *    that silently goes nowhere presents as "the code never arrives" and is
 *    close to impossible to diagnose from the outside.
 *  - Print a live sign-in code to the log in production. The log is not a
 *    delivery channel, and anything with access to it would hold every code.
 *  - Stand between a customer and their order. The confirmation is sent *after*
 *    the order has committed and its failure is swallowed — see
 *    `sendOrderConfirmation`. A bakery that cannot take an order because a mail
 *    provider is having a bad afternoon is worse than one that takes the order
 *    and sends no receipt.
 */

import { statusLabel } from '../shared/orderStatus.mjs';
import { adminHostname } from './config.js';
import { claimMailSend, recordMailSent, releaseMailClaim } from './repo/system.js';
import {
  BRAND, esc, money, numeric, shopOrigin, shell, heading, referenceBlock, itemsBlock,
  factsBlock, buttonBlock, noteBlock,
} from './emailTheme.js';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Where the bakery's copy of every order goes.
 *
 * Several addresses may be listed, comma separated — a shop inbox and a phone
 * that someone actually looks at are different things and both want the alert.
 */
export function adminOrderRecipients() {
  const configured = String(process.env.ADMIN_ORDER_EMAIL || '').trim();
  return (configured || 'hollandcookies.mf@gmail.com')
    .split(',').map((address) => address.trim()).filter(Boolean);
}

export function mailConfigured() {
  return process.env.MAIL_TRANSPORT === 'brevo' && Boolean(process.env.BREVO_API_KEY);
}

/**
 * Whether customer accounts can be offered at all.
 *
 * Sign-in is a code sent by email. With no way to deliver it the sign-in form
 * would be a control that can never work, so the storefront hides it instead.
 * The console transport counts, because development and the e2e suite read the
 * code from the server log.
 */
export function accountsAvailable() {
  return mailConfigured() || consoleTransportAllowed();
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Whether printing the message instead of sending it is allowed.
 *
 * Off in production unless somebody has explicitly asked for it by name, which
 * is the point: the end-to-end suite runs a production-configured server and
 * genuinely needs the console transport, but nothing should fall back to it by
 * accident. `MAIL_TRANSPORT=console` is a deliberate act; `NODE_ENV` drifting
 * is not.
 */
function consoleTransportAllowed() {
  return !isProduction() && process.env.MAIL_TRANSPORT === 'console';
}

function sender() {
  return {
    name: process.env.MAIL_FROM_NAME || 'Holland Cookies',
    email: process.env.MAIL_FROM_EMAIL || 'orders@hollandcookies.example',
  };
}

/**
 * Send one message.
 *
 * @returns {Promise<{ delivered: boolean, via: string }>}
 * @throws when it is production and there is no way to deliver — the caller
 *   turns that into a visible failure rather than a silent one.
 */
export async function sendMail({ to, subject, text, html }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { delivered: false, via: 'skipped-no-address' };
  if (!mailConfigured()) {
    if (!consoleTransportAllowed()) {
      const error = new Error('No mail provider is configured, so nothing can be sent.');
      error.code = 'MAIL_NOT_CONFIGURED';
      error.status = 503;
      throw error;
    }
    // Development only. This is the whole delivery channel until Brevo is
    // configured, and it is what makes the sign-in flow testable locally.
    console.log(
      `\n[holland:mail] (no provider configured — printing instead of sending)\n`
      + `  to:      ${recipients.join(', ')}\n  subject: ${subject}\n  ${text?.replace(/\n/g, '\n  ')}\n`,
    );
    return { delivered: false, via: 'console' };
  }

  const response = await fetch(BREVO_URL, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: sender(),
      to: recipients.map((email) => ({ email })),
      subject,
      textContent: text,
      // Tells well-behaved clients not to send an out-of-office reply to a
      // receipt, and marks the message as machine-generated for spam filters.
      headers: { 'Auto-Submitted': 'auto-generated' },
      ...(html ? { htmlContent: html } : {}),
      ...(process.env.MAIL_REPLY_TO
        ? { replyTo: { email: process.env.MAIL_REPLY_TO } }
        : {}),
    }),
  });

  if (!response.ok) {
    // The provider's own message is logged but not returned: it can quote the
    // recipient address back, and this error reaches a browser.
    await response.body?.cancel();
    console.error(JSON.stringify({event:'mail_failed',status:response.status}));
    const error = new Error('We could not send that email. Please try again.');
    error.code = 'MAIL_FAILED';
    error.status = 502;
    throw error;
  }

  await response.body?.cancel();
  return { delivered: true, via: 'brevo' };
}

/**
 * Send a message that must not be sent twice.
 *
 * The claim is taken before the provider is called and released if the call
 * fails, so a retry can still deliver. A message whose key is already claimed
 * resolves as skipped rather than throwing: a duplicate is not an error, it is
 * the thing this exists to prevent.
 */
async function sendOnce(dedupeKey, message) {
  if (!(await claimMailSend(dedupeKey))) return { delivered: false, via: 'skipped-duplicate' };
  try {
    const result = await sendMail(message);
    const recipients = Array.isArray(message.to) ? message.to : [message.to];
    await recordMailSent(dedupeKey, { to: recipients.join(', '), subject: message.subject });
    return result;
  } catch (error) {
    await releaseMailClaim(dedupeKey).catch(() => {});
    throw error;
  }
}

/** The sign-in code email. */
export async function sendSignInCode(email, code, lang = 'en') {
  const arabic = lang === 'ar';
  const subject = arabic ? `كود الدخول: ${code}` : `Your sign-in code: ${code}`;
  const text = arabic
    ? `كود الدخول بتاعك هو ${code}\n\nالكود صالح لعشر دقايق. لو مش إنت اللي طلبته، تجاهل الرسالة دي.`
    : `Your Holland Cookies sign-in code is ${code}\n\n`
      + `It is good for ten minutes. If you did not ask for it, ignore this email.`;

  const html = shell({
    lang, title: subject,
    preheader: arabic ? `كود الدخول ${code}` : `Sign-in code ${code}`,
    blocks: [
      heading({
        lang,
        accent: arabic ? 'تسجيل الدخول' : 'Sign in',
        title: arabic ? 'كود الدخول بتاعك' : 'Your sign-in code',
      }),
      `<tr><td style="padding:8px 28px 4px 28px;">
        <div style="display:inline-block;background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:14px;padding:16px 26px;">
          <span style="font-size:34px;font-weight:800;letter-spacing:.22em;color:${BRAND.cocoa};">${esc(code)}</span>
        </div>
      </td></tr>`,
      noteBlock({
        text: arabic
          ? 'الكود صالح لعشر دقايق. لو مش إنت اللي طلبته، تجاهل الرسالة دي.'
          : 'Good for ten minutes. If you did not ask for it, ignore this email.',
      }),
    ],
  });

  return sendMail({ to: email, subject, text, html });
}

// --------------------------------------------------------- order emails ----

/**
 * What every order email reads off the order.
 *
 * Built once, here, and shared by the customer's receipt, the bakery's alert
 * and the milestone updates. Nothing in it is computed: every figure is the one
 * the server stored, so an email cannot disagree with the receipt on screen or
 * with the dashboard. That was already the rule for the confirmation; keeping
 * one model is what stops the three messages drifting apart.
 */
function orderModel(order, arabic = false) {
  const pick = (english, ar) => (arabic && ar ? ar : english);
  const lines = (order.items ?? []).map((item) => {
    const product = pick(item.name, item.nameAr);
    const option = item.choice ? pick(item.choice.name, item.choice.nameAr) : '';
    const name = option ? `${product} — ${option}` : product;
    const inside = [...(item.selections ?? []), ...(item.components ?? [])]
      .map((part) => `${part.quantity}× ${pick(part.name, part.nameAr)}`);
    return {
      name: inside.length ? `${name} (${inside.join(', ')})` : name,
      qty: item.qty,
      total: item.lineTotal,
    };
  });

  const delivery = order.fulfilment === 'delivery';
  const totals = [
    [arabic ? 'الإجمالي الفرعي' : 'Subtotal', order.subtotal],
    ...(order.discount ? [[arabic ? 'الخصم' : 'Discount', -order.discount]] : []),
    ...(delivery ? [[arabic ? 'التوصيل' : 'Delivery', order.delivery]] : []),
  ];

  // The stored order is flat — `orderPayload` is what nests it for the API, and
  // this reads the document, not the payload.
  const address = delivery ? [
    order.address,
    order.building && `${arabic ? 'عمارة' : 'Building'} ${order.building}`,
    order.floor && `${arabic ? 'دور' : 'Floor'} ${order.floor}`,
    order.apartment && `${arabic ? 'شقة' : 'Apt'} ${order.apartment}`,
    order.landmark,
  ].filter(Boolean).join(', ') : '';

  return {
    lines,
    totals,
    delivery,
    address,
    total: order.total,
    reference: order.reference,
    firstName: order.firstName || '',
    totalLabel: arabic ? 'الإجمالي' : 'Total',
    paymentNote: delivery
      ? (arabic ? 'الدفع كاش عند الاستلام.' : 'Payment is cash on delivery.')
      : (arabic ? 'الدفع كاش عند الاستلام من الفرع.' : 'Payment is cash on pickup.'),
  };
}

/** The plain-text part. Built separately rather than stripped out of the HTML. */
function orderText(model, { intro, closing, arabic }) {
  return [
    intro,
    ``,
    `${arabic ? 'رقم الطلب' : 'Order'}: ${model.reference}`,
    ``,
    ...model.lines.map((line) => `  ${line.qty} x ${line.name}  ${money(line.total)}`),
    ``,
    ...model.totals.map(([label, value]) => `${label}: ${money(value)}`),
    `${model.totalLabel}: ${money(model.total)}`,
    ``,
    closing,
  ].join('\n');
}

/** The tracking page for one order — the only link a customer needs. */
const trackUrl = (reference) => `${shopOrigin()}/track?reference=${encodeURIComponent(reference)}`;

/** The dashboard lives on its own host; see ADMIN_HOSTNAME in backend/config.js. */
function dashboardOrderUrl(reference) {
  const url = new URL(shopOrigin());
  url.hostname = adminHostname();
  return `${url.origin}/orders/${encodeURIComponent(reference)}`;
}

/**
 * The order confirmation, to the customer.
 *
 * Sent once per order: the dedupe key is the reference, so a retried submission
 * that returns the original order cannot turn one order into two receipts even
 * if a future caller forgets to check `duplicate`.
 */
export async function sendOrderConfirmation(order, lang = 'en') {
  const arabic = lang === 'ar';
  const to = order.email;
  if (!to) return { delivered: false, via: 'skipped-no-address' };

  const model = orderModel(order, arabic);
  const subject = arabic
    ? `تأكيد طلبك ${order.reference}`
    : `Your Holland Cookies order ${order.reference}`;

  const text = orderText(model, {
    arabic,
    intro: arabic ? 'شكراً! استلمنا طلبك.' : 'Thank you — we have your order.',
    closing: [
      model.paymentNote,
      ``,
      arabic
        ? `تقدر تتابع طلبك برقم الطلب ورقم تليفونك: ${trackUrl(order.reference)}`
        : `You can track it with your order number and phone number: ${trackUrl(order.reference)}`,
    ].join('\n'),
  });

  const html = shell({
    lang,
    title: subject,
    preheader: arabic
      ? `استلمنا طلبك ${order.reference}`
      : `We have your order ${order.reference}`,
    blocks: [
      heading({
        lang,
        accent: arabic ? 'تأكيد الطلب' : 'Order confirmed',
        title: model.firstName
          ? (arabic ? `شكراً يا ${model.firstName}!` : `Thank you, ${model.firstName}!`)
          : (arabic ? 'شكراً!' : 'Thank you!'),
        lead: arabic
          ? 'استلمنا طلبك وبدأنا نجهزه. هنبعتلك تحديث أول ما يتحرك.'
          : 'We have your order and we are getting it ready. We will write again when it moves.',
      }),
      referenceBlock({ lang, reference: model.reference }),
      itemsBlock({
        lang,
        lines: model.lines,
        totals: model.totals,
        total: model.total,
        totalLabel: model.totalLabel,
      }),
      factsBlock({
        lang,
        title: arabic ? 'التوصيل' : 'Fulfilment',
        rows: [
          [arabic ? 'الطريقة' : 'Method', model.delivery
            ? (arabic ? 'توصيل' : 'Delivery')
            : (arabic ? 'استلام من الفرع' : 'Pickup')],
          ...(model.address ? [[arabic ? 'العنوان' : 'Address', model.address]] : []),
        ],
      }),
      buttonBlock({
        href: trackUrl(model.reference),
        label: arabic ? 'تابع طلبك' : 'Track your order',
      }),
      noteBlock({ text: model.paymentNote }),
    ],
  });

  return sendOnce(`confirmation:${order.reference}`, { to, subject, text, html });
}

/**
 * The new-order alert, to the bakery.
 *
 * The one message addressed to the shop rather than to a customer, and the only
 * one carrying the customer's phone and address — somebody reads this to start
 * baking, so it leads with how to reach them rather than with thanks. Always in
 * English: it is read by staff, not by the customer.
 */
export async function sendAdminOrderAlert(order) {
  const to = adminOrderRecipients();
  const model = orderModel(order, false);
  const subject = `New order ${order.reference} — ${money(order.total)}`;

  const text = orderText(model, {
    arabic: false,
    intro: `New order ${order.reference}.`,
    closing: [
      `Customer: ${`${order.firstName || ''} ${order.lastName || ''}`.trim() || '—'}`,
      `Phone: ${order.phone || '—'}`,
      `Email: ${order.email || '—'}`,
      `${model.delivery ? 'Delivery' : 'Pickup'}${model.address ? ` to ${model.address}` : ''}`,
      order.notes ? `Notes: ${order.notes}` : '',
      ``,
      `Open the dashboard: ${dashboardOrderUrl(order.reference)}`,
    ].filter(Boolean).join('\n'),
  });

  const html = shell({
    lang: 'en',
    title: subject,
    preheader: `${order.firstName || 'A customer'} ordered ${money(order.total)}`,
    blocks: [
      heading({
        accent: 'New order',
        title: `${money(order.total)} — ${model.delivery ? 'delivery' : 'pickup'}`,
        lead: 'A customer has just placed an order.',
      }),
      referenceBlock({ reference: model.reference }),
      factsBlock({
        title: 'Customer',
        rows: [
          ['Name', `${order.firstName || ''} ${order.lastName || ''}`.trim()],
          ['Phone', order.phone || ''],
          ['Email', order.email || ''],
          ['Fulfilment', model.delivery ? 'Delivery' : 'Pickup'],
          ['Address', model.address],
          ['Payment', order.paymentMethod === 'online' ? 'Paid online' : 'Cash'],
          ['Notes', order.notes || ''],
        ],
      }),
      itemsBlock({
        lines: model.lines,
        totals: model.totals,
        total: model.total,
        totalLabel: model.totalLabel,
      }),
      buttonBlock({ href: dashboardOrderUrl(order.reference), label: 'Open in the dashboard' }),
    ],
  });

  return sendOnce(`admin:${order.reference}`, { to, subject, text, html });
}

/**
 * The milestone update, to the customer.
 *
 * Only `in_transit` and `completed` are announced, and what each says depends on
 * whether the order is delivered or collected — which is exactly the split
 * `statusLabel` already owns, so the wording is derived from the shared status
 * model rather than from a second copy of it here. Every other status,
 * `cancelled` included, sends nothing: a cancellation is a conversation the shop
 * has with the customer, not an automated mail.
 */
export async function sendOrderStatusUpdate(order, status, lang = 'en') {
  const to = order.email;
  if (!to) return { delivered: false, via: 'skipped-no-address' };
  if (status !== 'in_transit' && status !== 'completed') {
    return { delivered: false, via: 'skipped-not-announced' };
  }

  const arabic = lang === 'ar';
  const model = orderModel(order, arabic);
  // `statusLabel` is the shared English name used by the shop's own screens.
  // An Arabic email must not put an English status in front of the customer,
  // and the status model carries no Arabic, so the Arabic wording lives with
  // the rest of the Arabic copy for this message.
  const copy = milestoneCopy({ status, delivery: model.delivery, arabic, firstName: model.firstName });
  const label = arabic ? copy.label : statusLabel(status, model.delivery ? 'delivery' : 'pickup');
  const subject = arabic
    ? `${copy.title} — طلبك ${order.reference}`
    : `${copy.title} — order ${order.reference}`;

  const text = [
    copy.title,
    ``,
    copy.lead,
    ``,
    `${arabic ? 'رقم الطلب' : 'Order'}: ${model.reference}`,
    `${arabic ? 'الحالة' : 'Status'}: ${label}`,
    `${model.totalLabel}: ${money(model.total)}`,
    ``,
    `${arabic ? 'تابع طلبك' : 'Track your order'}: ${trackUrl(model.reference)}`,
  ].join('\n');

  const html = shell({
    lang,
    title: subject,
    preheader: copy.lead,
    blocks: [
      heading({ lang, accent: label, title: copy.title, lead: copy.lead }),
      referenceBlock({ lang, reference: model.reference }),
      factsBlock({
        lang,
        title: arabic ? 'طلبك' : 'Your order',
        rows: [
          [arabic ? 'الحالة' : 'Status', label],
          [model.totalLabel, numeric(money(model.total))],
          ...(model.delivery && model.address ? [[arabic ? 'العنوان' : 'Address', model.address]] : []),
        ],
      }),
      buttonBlock({
        href: trackUrl(model.reference),
        label: arabic ? 'تابع طلبك' : 'Track your order',
      }),
      noteBlock({ text: copy.note }),
    ],
  });

  return sendOnce(`status:${order.reference}:${status}`, { to, subject, text, html });
}

/** What each milestone says. Four messages out of two statuses. */
function milestoneCopy({ status, delivery, arabic, firstName }) {
  const name = firstName ? (arabic ? ` يا ${firstName}` : `, ${firstName}`) : '';
  if (status === 'in_transit') {
    return delivery
      ? {
        label: 'في الطريق',
        title: arabic ? 'طلبك في الطريق' : 'Your order is on its way',
        lead: arabic
          ? `طلبك خرج من الفرن وفي طريقه ليك${name}.`
          : `Your order has left the bakery and is on its way to you${name}.`,
        note: arabic ? 'السائق هيتصل بيك لما يوصل.' : 'The driver will call when they arrive.',
      }
      : {
        label: 'جاهز للاستلام',
        title: arabic ? 'طلبك جاهز للاستلام' : 'Your order is ready for pickup',
        lead: arabic
          ? `طلبك جاهز ومستنيك في الفرع${name}.`
          : `Your order is baked and waiting for you at the shop${name}.`,
        note: arabic ? 'قول رقم الطلب عند الاستلام.' : 'Give your order number at the counter.',
      };
  }
  return delivery
    ? {
      label: 'اتسلم',
      title: arabic ? 'طلبك وصل' : 'Your order has arrived',
      lead: arabic
        ? `طلبك اتسلم${name}. بالهنا والشفا!`
        : `Your order has been delivered${name}. Enjoy every crumb.`,
      note: arabic
        ? 'لو في أي حاجة مش مظبوطة، رد على الرسالة دي.'
        : 'If anything is not right, just reply to this email.',
    }
    : {
      label: 'تم الاستلام',
      title: arabic ? 'شكراً على استلام طلبك' : 'Thanks for collecting your order',
      lead: arabic
        ? `استلمت طلبك من الفرع${name}. بالهنا والشفا!`
        : `You have picked up your order${name}. Enjoy every crumb.`,
      note: arabic
        ? 'لو في أي حاجة مش مظبوطة، رد على الرسالة دي.'
        : 'If anything is not right, just reply to this email.',
    };
}
