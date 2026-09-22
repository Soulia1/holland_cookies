/**
 * The look of every email Holland Cookies sends.
 *
 * One theme module rather than markup inlined per message, because an email is
 * the only part of this shop that is rendered by software we do not control.
 * Gmail, Outlook and Apple Mail each strip a different subset of CSS, so the
 * rules below are deliberately old-fashioned: tables for layout, every colour
 * and size inlined on the element, no class names, no flexbox, no grid, no
 * external stylesheet, no web font. That is not conservatism for its own sake —
 * Outlook renders with Word's engine, which supports none of those.
 *
 * The palette is Holland's own, taken from the storefront's tokens in
 * src/index.css so the receipt in an inbox and the page it came from are
 * recognisably the same shop. It is NOT Scooby's cream-and-caramel: these are
 * two bakeries and their mail should not be mistakable for each other.
 *
 * Arabic is a first-class case here, not a translation layer bolted on. `dir`
 * belongs on the elements themselves because a `dir` on <html> does not survive
 * Gmail, which reparents the body of the message into its own document.
 */

/** Straight from src/index.css. Keep these in step with the storefront. */
export const BRAND = {
  cocoa: '#271310',
  cocoaSoft: '#3e2723',
  cream: '#fff8f6',
  card: '#ffffff',
  rose: '#e3beb8',
  border: '#e8e1df',
  line: '#d3c3c0',
  ink: '#1e1b1a',
  muted: '#504442',
  berry: '#5d101d',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/**
 * Escape for HTML.
 *
 * Product names, a customer's own name and their note to the kitchen all reach
 * these templates. They are validated on the way in, but validated is not
 * escaped: a name containing `<` belongs in an email as a `<`, and the encoding
 * for that is applied here, where the string becomes markup. The text part
 * needs none of it, which is why the two parts are built separately rather than
 * by stripping tags out of one.
 */
export const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export const money = (amount) => `${Number(amount || 0).toFixed(2)} EGP`;

/**
 * Keep a number reading left to right inside Arabic.
 *
 * "427.00 EGP" in a right-to-left paragraph is reordered by the bidi algorithm
 * and displays as "EGP 427.00", which is not what the shop charges anybody but
 * reads as though it might be. The marks pin the run; they are invisible, and
 * in a left-to-right message they do nothing at all.
 */
export const numeric = (text) => `‎${String(text)}‎`;

/** The public address of the shop, for links out of an email. */
export function shopOrigin() {
  const configured = String(process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  return configured || 'https://holland-cookies.com';
}

/**
 * The frame every message sits in.
 *
 * `preheader` is the grey line an inbox shows next to the subject. Left unset,
 * clients invent one from the first text they find, which for a receipt is the
 * wordmark — so every email in the list would read "Holland Cookies".
 */
export function shell({ lang = 'en', preheader = '', title = '', blocks = [] }) {
  const rtl = lang === 'ar';
  const align = rtl ? 'right' : 'left';
  return `<!doctype html>
<html lang="${rtl ? 'ar' : 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${BRAND.cream};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.cream};padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" dir="${rtl ? 'rtl' : 'ltr'}"
      style="max-width:600px;width:100%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:18px;overflow:hidden;font-family:${FONT};text-align:${align};">
      <tr><td style="background:${BRAND.cocoa};padding:22px 28px;">
        <div style="font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${BRAND.rose};">Holland Cookies</div>
      </td></tr>
      ${blocks.join('')}
      <tr><td style="background:${BRAND.cream};border-top:1px solid ${BRAND.border};padding:18px 28px;">
        <div style="font-size:12px;color:${BRAND.muted};line-height:1.6;">
          ${rtl ? 'وصلتك الرسالة دي لأنك طلبت من هولاند كوكيز.' : 'You are receiving this because you ordered from Holland Cookies.'}
          <br><a href="${esc(shopOrigin())}" style="color:${BRAND.berry};text-decoration:none;">${esc(shopOrigin().replace(/^https?:\/\//, ''))}</a>
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/** A headline with an optional lead paragraph. */
export function heading({ lang = 'en', title, lead = '', accent = '' }) {
  const rtl = lang === 'ar';
  return `<tr><td style="padding:28px 28px 8px 28px;">
    ${accent ? `<div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.berry};padding-bottom:10px;">${esc(accent)}</div>` : ''}
    <div style="font-size:23px;font-weight:800;letter-spacing:-0.2px;color:${BRAND.ink};line-height:1.3;">${esc(title)}</div>
    ${lead ? `<div style="font-size:15px;color:${BRAND.muted};line-height:1.65;padding-top:10px;">${esc(lead)}</div>` : ''}
  </td>${rtl ? '' : ''}</tr>`;
}

/** The order reference, set as the one thing worth reading twice. */
export function referenceBlock({ lang = 'en', reference }) {
  const rtl = lang === 'ar';
  return `<tr><td style="padding:14px 28px 4px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:12px;">
      <tr><td style="padding:14px 18px;">
        <div style="font-size:12px;color:${BRAND.muted};letter-spacing:.08em;text-transform:uppercase;">${rtl ? 'رقم الطلب' : 'Order number'}</div>
        <div style="font-size:22px;font-weight:800;letter-spacing:.06em;color:${BRAND.cocoa};padding-top:4px;">${esc(reference)}</div>
      </td></tr>
    </table>
  </td></tr>`;
}

/**
 * The ordered items, then the totals.
 *
 * `lines` and `totals` are already-formatted rows: this renders what it is
 * given and computes nothing. Every figure in an email must come off the
 * stored order, so arithmetic here would be a second source of truth.
 */
export function itemsBlock({ lang = 'en', lines, totals, total, totalLabel }) {
  const rtl = lang === 'ar';
  const end = rtl ? 'left' : 'right';
  return `<tr><td style="padding:18px 28px 6px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:${BRAND.ink};">
      ${lines.map((line) => `<tr>
        <td style="padding:7px 0;line-height:1.5;">
          <span style="color:${BRAND.muted};">${esc(line.qty)}&times;</span> ${esc(line.name)}
        </td>
        <td style="padding:7px 0;text-align:${end};white-space:nowrap;" dir="ltr">${money(line.total)}</td>
      </tr>`).join('')}
      <tr><td colspan="2" style="border-top:1px solid ${BRAND.border};font-size:0;line-height:0;padding-top:10px;">&nbsp;</td></tr>
      ${totals.map(([label, value]) => `<tr>
        <td style="padding:3px 0;color:${BRAND.muted};">${esc(label)}</td>
        <td style="padding:3px 0;text-align:${end};color:${BRAND.muted};white-space:nowrap;" dir="ltr">${money(value)}</td>
      </tr>`).join('')}
      <tr>
        <td style="padding:10px 0 0 0;font-weight:800;font-size:16px;">${esc(totalLabel)}</td>
        <td style="padding:10px 0 0 0;text-align:${end};font-weight:800;font-size:16px;white-space:nowrap;" dir="ltr">${money(total)}</td>
      </tr>
    </table>
  </td></tr>`;
}

/** A labelled block of facts — delivery details, customer details. */
export function factsBlock({ lang = 'en', title, rows }) {
  const kept = rows.filter(([, value]) => value !== '' && value != null);
  if (!kept.length) return '';
  const rtl = lang === 'ar';
  const end = rtl ? 'left' : 'right';
  return `<tr><td style="padding:14px 28px 4px 28px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:${BRAND.cream};border:1px solid ${BRAND.border};border-radius:12px;">
      <tr><td style="padding:14px 18px;">
        ${title ? `<div style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${BRAND.muted};padding-bottom:8px;">${esc(title)}</div>` : ''}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:${BRAND.ink};">
          ${kept.map(([label, value]) => `<tr>
            <td style="padding:3px 0;color:${BRAND.muted};white-space:nowrap;">${esc(label)}</td>
            <td style="padding:3px 0;text-align:${end};line-height:1.5;">${esc(value)}</td>
          </tr>`).join('')}
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

/** A single call to action. Email clients do not honour a styled <button>. */
export function buttonBlock({ href, label }) {
  return `<tr><td style="padding:20px 28px 8px 28px;">
    <a href="${esc(href)}" style="display:inline-block;background:${BRAND.cocoa};color:${BRAND.cream};font-size:15px;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:999px;">${esc(label)}</a>
  </td></tr>`;
}

/** A closing note, quieter than the body. */
export function noteBlock({ text }) {
  if (!text) return '';
  return `<tr><td style="padding:14px 28px 26px 28px;">
    <div style="font-size:13px;color:${BRAND.muted};line-height:1.65;">${esc(text)}</div>
  </td></tr>`;
}
