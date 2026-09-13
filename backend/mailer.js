/**
 * Sending mail.
 *
 * One transport interface with one real implementation — Brevo — which
 * activates the moment `BREVO_API_KEY` is set, plus a development fallback that
 * writes the message to the server log.
 *
 * Two messages are sent: the sign-in code, and the order confirmation.
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

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export function mailConfigured() {
  return Boolean(process.env.BREVO_API_KEY);
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
      + `  to:      ${to}\n  subject: ${subject}\n  ${text?.replace(/\n/g, '\n  ')}\n`,
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
      to: [{ email: to }],
      subject,
      textContent: text,
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

/** The sign-in code email. */
export async function sendSignInCode(email, code, lang = 'en') {
  const arabic = lang === 'ar';
  const subject = arabic ? `كود الدخول: ${code}` : `Your sign-in code: ${code}`;
  const text = arabic
    ? `كود الدخول بتاعك هو ${code}\n\nالكود صالح لعشر دقايق. لو مش إنت اللي طلبته، تجاهل الرسالة دي.`
    : `Your Holland Cookies sign-in code is ${code}\n\n`
      + `It is good for ten minutes. If you did not ask for it, ignore this email.`;

  const html = `<div style="font-family:system-ui,sans-serif;max-width:420px">
  <p style="font-size:14px;color:#5d101d;font-weight:600;letter-spacing:.12em;text-transform:uppercase">
    Holland Cookies</p>
  <p style="font-size:15px;color:#333">${arabic ? 'كود الدخول بتاعك' : 'Your sign-in code'}</p>
  <p style="font-size:34px;font-weight:700;letter-spacing:.16em;color:#5d101d;margin:8px 0">${code}</p>
  <p style="font-size:13px;color:#777">${
    arabic
      ? 'الكود صالح لعشر دقايق. لو مش إنت اللي طلبته، تجاهل الرسالة دي.'
      : 'Good for ten minutes. If you did not ask for it, ignore this email.'
  }</p>
</div>`;

  return sendMail({ to: email, subject, text, html });
}

// --------------------------------------------------------- order receipt ----

const EGP = (value) => `${Number(value).toFixed(2)} EGP`;

/**
 * Escape for HTML.
 *
 * Product names and the customer's own name go into this email. They are
 * already bounded and validated on the way in, but "validated" is not
 * "escaped" — a name containing `<` belongs in an email as a `<`, and the
 * contextual encoding for HTML is this, applied here, at the point the string
 * becomes markup. The plain-text part needs none of it, which is exactly why
 * the two are built separately rather than by stripping tags from one.
 */
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The order confirmation.
 *
 * Deliberately reflects only what the server decided. Every figure here is read
 * back off the stored order, never recomputed and never taken from the request,
 * so the email cannot disagree with the receipt or with the dashboard.
 */
export async function sendOrderConfirmation(order, lang = 'en') {
  const arabic = lang === 'ar';
  const to = order.email;
  if (!to) return { delivered: false, via: 'skipped-no-address' };

  const subject = arabic
    ? `تأكيد طلبك ${order.reference}`
    : `Your Holland Cookies order ${order.reference}`;

  const lines = (order.items ?? []).map((item) => {
    const name = arabic && item.nameAr ? item.nameAr : item.name;
    const inside = [...(item.selections ?? []), ...(item.components ?? [])]
      .map((part) => `${part.quantity}× ${arabic && part.nameAr ? part.nameAr : part.name}`);
    return {
      name: inside.length ? `${name} (${inside.join(', ')})` : name,
      qty: item.qty,
      total: item.lineTotal,
    };
  });

  const totals = [
    [arabic ? 'الإجمالي الفرعي' : 'Subtotal', order.subtotal],
    ...(order.discount ? [[arabic ? 'الخصم' : 'Discount', -order.discount]] : []),
    ...(order.fulfilment === 'delivery' ? [[arabic ? 'التوصيل' : 'Delivery', order.delivery]] : []),
  ];

  const text = [
    arabic ? `شكراً! استلمنا طلبك.` : `Thank you — we have your order.`,
    ``,
    `${arabic ? 'رقم الطلب' : 'Order'}: ${order.reference}`,
    ``,
    ...lines.map((l) => `  ${l.qty} x ${l.name}  ${EGP(l.total)}`),
    ``,
    ...totals.map(([label, value]) => `${label}: ${EGP(value)}`),
    `${arabic ? 'الإجمالي' : 'Total'}: ${EGP(order.total)}`,
    ``,
    order.fulfilment === 'delivery'
      ? (arabic ? 'الدفع كاش عند الاستلام.' : 'Payment is cash on delivery.')
      : (arabic ? 'الدفع كاش عند الاستلام من الفرع.' : 'Payment is cash on pickup.'),
    ``,
    arabic
      ? `تقدر تتابع طلبك برقم الطلب ورقم تليفونك.`
      : `You can track it with your order number and phone number.`,
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px"${arabic ? ' dir="rtl"' : ''}>
  <p style="font-size:14px;color:#5d101d;font-weight:600;letter-spacing:.12em;text-transform:uppercase">
    Holland Cookies</p>
  <p style="font-size:15px;color:#333">${arabic ? 'شكراً! استلمنا طلبك.' : 'Thank you — we have your order.'}</p>
  <p style="font-size:24px;font-weight:700;letter-spacing:.08em;color:#5d101d;margin:8px 0">${esc(order.reference)}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;color:#333;margin-top:16px">
    ${lines.map((l) => `<tr>
      <td style="padding:4px 0">${esc(l.qty)} &times; ${esc(l.name)}</td>
      <td style="padding:4px 0;text-align:${arabic ? 'left' : 'right'}">${EGP(l.total)}</td>
    </tr>`).join('')}
    <tr><td colspan="2" style="border-top:1px solid #e5e5e5;padding-top:8px"></td></tr>
    ${totals.map(([label, value]) => `<tr>
      <td style="padding:2px 0;color:#777">${esc(label)}</td>
      <td style="padding:2px 0;text-align:${arabic ? 'left' : 'right'};color:#777">${EGP(value)}</td>
    </tr>`).join('')}
    <tr>
      <td style="padding:6px 0;font-weight:700">${arabic ? 'الإجمالي' : 'Total'}</td>
      <td style="padding:6px 0;text-align:${arabic ? 'left' : 'right'};font-weight:700">${EGP(order.total)}</td>
    </tr>
  </table>
  <p style="font-size:13px;color:#777;margin-top:16px">${
    order.fulfilment === 'delivery'
      ? (arabic ? 'الدفع كاش عند الاستلام.' : 'Payment is cash on delivery.')
      : (arabic ? 'الدفع كاش عند الاستلام من الفرع.' : 'Payment is cash on pickup.')
  }</p>
</div>`;

  return sendMail({ to, subject, text, html });
}
