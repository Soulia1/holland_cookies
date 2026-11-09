import { Router } from 'express';
import { z } from 'zod';
import { collections } from '../firestore.js';
import { requireAdmin } from '../adminSession.js';
import { mailConfigured, sendMail } from '../mailer.js';
import { esc, shell, heading } from '../emailTheme.js';
import { limit } from '../security.js';

const router = Router();
router.use(requireAdmin);
export function campaignCustomers(orders) {
  const byEmail = new Map();
  for (const order of orders) {
    const customer = order;
    const email = String(customer.email || '').trim().toLowerCase();
    if (!z.email().safeParse(email).success) continue;
    const existing = byEmail.get(email);
    if (existing) existing.orders++;
    else byEmail.set(email, { email, name: [customer.firstName, customer.lastName].filter(Boolean).join(' '), orders: 1 });
  }
  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}
async function customers() {
  const snap = await collections.orders().select('email', 'firstName', 'lastName').get();
  return campaignCustomers(snap.docs.map(doc => doc.data()));
}
router.get('/customers', async (_req, res, next) => {
  try { res.json(await customers()); } catch (error) { next(error); }
});
const message = z.strictObject({ subject: z.string().trim().min(1).max(200).refine(s => !/[\r\n]/.test(s)), body: z.string().trim().min(1).max(20000) });
let broadcasting = false;
router.post('/broadcast', limit('campaign-send', 60000, 2), async (req, res, next) => {
  const parsed = message.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Enter a subject and message within the allowed lengths.' });
  if (!mailConfigured()) return res.status(503).json({ message: 'Configure Holland’s Brevo email provider before sending campaigns.' });
  if (broadcasting) return res.status(409).json({ message: 'A campaign is already sending. Please wait for it to finish.' });
  broadcasting = true;
  try {
    const recipients = await customers();
    if (!recipients.length) return res.status(400).json({ message: 'No customers with an email address to send to.' });
    const { subject, body } = parsed.data;
    let sent = 0;
    const failures = [];
    for (const customer of recipients) {
      const greeting = customer.name ? 'Hi ' + customer.name + ',\n\n' : '';
      const html = shell({ title: subject, blocks: [heading({ title: subject }), '<div style="font-size:15px;line-height:1.7">' + esc(greeting + body).replace(/\n/g, '<br>') + '</div>'] });
      try {
        const result = await sendMail({ to: customer.email, subject, text: greeting + body, html });
        if (!result.delivered) throw Error('Not delivered');
        sent++;
      } catch { failures.push({ email: customer.email }); }
    }
    res.json({ sent, failed: failures.length, failures });
  } catch (error) { next(error); } finally { broadcasting = false; }
});
export default router;
