/**
 * Sending mail.
 *
 * Holland has no mail provider wired up yet, and this module is careful to be
 * honest about that rather than to pretend otherwise. It is a transport
 * *interface* with one real implementation (Brevo, the provider Scooby uses)
 * that activates the moment `BREVO_API_KEY` is set, and a development fallback
 * that writes the message to the server log.
 *
 * The two things it must never do:
 *
 *  - Resolve successfully in production when nothing was sent. A sign-in code
 *    that silently goes nowhere presents as "the code never arrives" and is
 *    close to impossible to diagnose from the outside.
 *  - Print a live sign-in code to the log in production. The log is not a
 *    delivery channel, and anything with access to it would hold every code.
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
