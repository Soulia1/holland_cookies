# Email — Brevo

Holland Cookie sends four kinds of message, all through Brevo's transactional
API (`POST https://api.brevo.com/v3/smtp/email`):

| Message | To | Trigger | Blocking? |
|---|---|---|---|
| **Sign-in code** | The customer | They request a one-time code | **Yes** — they are waiting for it, and a failure must be visible |
| **Order confirmation** | The customer | An order commits | **No** — sent after the fact, failure logged and dropped |
| **New-order alert** | The bakery (`ADMIN_ORDER_EMAIL`) | An order commits | **No** — same terms as the confirmation |
| **Milestone update** | The customer | An order reaches `in_transit` or `completed` | **No** — sent after the status has committed |

That difference is the most important thing in this document. A sign-in code
that silently goes nowhere presents as "the code never arrives" and is nearly
impossible to diagnose from outside, so `POST /api/account/request-code`
surfaces a mail failure as a `502`. An order confirmation that fails must never
undo or block an order that is already in the database — so it is not awaited,
and its rejection is caught and logged. The bakery's alert and the milestone
updates follow the same rule: an admin moving an order along is never left
waiting on a mail provider, and never sees the move fail because one refused.

## What gets announced, and what does not

Only two statuses email the customer. Holland's statuses are
fulfilment-neutral, so those two produce four messages:

| Status | Delivery | Pickup |
|---|---|---|
| `in_transit` | "Your order is on its way" | "Your order is ready for pickup" |
| `completed` | "Your order has arrived" | "Thanks for collecting your order" |

`ordered`, `confirmed` and `baking` send nothing — a mail per internal step is
noise, and noise is what gets a sender blocked. `cancelled` sends nothing
either: a cancellation is a conversation the shop has with the customer, not an
automated message.

## Sending once, and only once

Every message that must not repeat claims a key in the `mailLog` collection
*before* the provider is called: `confirmation:<reference>`,
`admin:<reference>`, `status:<reference>:<status>`. The claim is a Firestore
`create()`, which fails if the document exists — a read followed by a write is
not a lock, and two concurrent requests would both read "nothing sent" and both
send. A failed send releases its claim so a later attempt can still deliver.

**The trap:** the key is the order reference, so wiping `counters` (which
restarts references at `HC-1001`) without also wiping `mailLog` leaves a claim
on every reference the next run is about to mint, and every send is skipped —
silently, because a duplicate is not an error. The test harnesses clear both
together; production never resets the counter.

## The look of the messages

`backend/emailTheme.js` holds Holland's palette and the shared layout: tables,
inline styles, no class names, no web font, because Outlook renders with Word's
engine. It is Holland's own palette from `src/index.css`, not Scooby's — two
bakeries whose mail should not be mistakable for each other. Arabic orders get
`dir="rtl"` on the elements themselves, since a `dir` on `<html>` does not
survive Gmail reparenting the message.

## Switching it on

### 1. Get an API key

Brevo dashboard → **SMTP & API** → **API keys** → *Generate a new API key*.
It is a v3 key, `xkeysib-…`. Copy it once; Brevo will not show it again.

### 2. Verify a sender

**This is the step that silently breaks everything if skipped.** Brevo accepts
the API call and returns a happy `201` for an unverified sender, then delivers
nothing. There is no error to find.

Brevo dashboard → **Senders, Domains & Dedicated IPs** → **Senders** → add the
address you will send from, and complete the verification email.

For anything beyond testing, authenticate the **domain** too and add the records
Brevo gives you. Without them, mail from a real domain lands in spam or is
rejected outright by Gmail and Outlook.

**Done on 2026-09-22.** The sending domain is the subdomain
`mail.holland-cookies.com`, authenticated with four records on the Railway DNS
for `holland-cookies.com` (Workspace → Settings → Domains → holland-cookies.com):
a `brevo-code` TXT on `mail`, two DKIM CNAMEs on `brevo1._domainkey.mail` and
`brevo2._domainkey.mail`, and a DMARC TXT on `_dmarc.mail` at `p=none`. Brevo
reports the domain Authenticated and the sender
`Holland Cookies <orders@mail.holland-cookies.com>` Verified, with DKIM and
DMARC green — so senders on this domain need no per-address verification email.
A sending subdomain keeps the shop's own domain free for a real mailbox and
keeps this traffic's reputation separate. The old Gmail sender is still listed
and is still flagged as freemail; prefer the new address.

### 3. Configure the environment

```bash
BREVO_API_KEY=xkeysib-…                            # the v3 key
MAIL_FROM_EMAIL=orders@mail.holland-cookies.com    # MUST be a verified sender
MAIL_FROM_NAME=Holland Cookies     # optional, defaults to this
MAIL_REPLY_TO=hello@yourdomain     # optional
MAIL_TRANSPORT=brevo               # optional; the key alone is what activates it
```

In production the config validator requires `BREVO_API_KEY` (≥20 chars) and a
valid `MAIL_FROM_EMAIL`, and the server will not boot without them.

`BREVO_BASE_URL` is deliberately **not** a variable. The API URL is pinned in
`backend/mailer.js` so that no stray environment variable can redirect outbound
mail somewhere else, and the production validator rejects the environment if it
is set.

### 4. Verify it before trusting it

```bash
npm run mail:check -- you@example.com
```

This checks the key against `/v3/account`, lists the account's verified senders
and **refuses if `MAIL_FROM_EMAIL` is not among them** — which is the failure
mode step 2 warns about — then sends one real message through the application's
own mailer, not a hand-rolled request.

It costs one send against the account quota, and its last word is the honest
one: *accepted is not delivered*. Go and look in the inbox, and in spam.

## Behaviour when mail is off or failing

| Situation | Sign-in code | Order confirmation | Order itself |
|---|---|---|---|
| No `BREVO_API_KEY`, `NODE_ENV≠production`, `MAIL_TRANSPORT=console` | Printed to the server log | Printed to the server log | **Succeeds** |
| No `BREVO_API_KEY`, production | `503 MAIL_NOT_CONFIGURED` | Logged as failed, dropped | **Succeeds** |
| Provider returns 5xx | `502 MAIL_FAILED` | Logged as failed, dropped | **Succeeds** |
| Provider times out (5s) | `502` | Logged as failed, dropped | **Succeeds** |
| Customer gave no email address | n/a | Skipped, not an error | **Succeeds** |

Every row of that "order itself" column is asserted by
`tests/security/security.test.js`.

## Guarantees the tests pin

- **A missing provider never costs an order** — checkout returns 201 with no key set.
- **A failing provider never costs an order** — provider returns 500, checkout still 201.
- **One order, one email** — a replayed idempotency key returns the original
  order and sends *nothing*, so a retried submission cannot produce a second
  receipt in the customer's inbox.
- **No address is not a failure** — a guest with no email triggers no send and no error.
- **Product names are escaped** — a product called
  `<img src=x onerror=alert(1)>` appears as text in the HTML part and verbatim
  in the plain-text part. HTML and text are built separately rather than by
  stripping tags from one.
- **No retry** — a failed send is not retried. A retry loop against a provider
  having a bad afternoon is how one order becomes forty emails.
- **No redirects** — `redirect: 'error'`, so a hijacked or misconfigured
  response cannot walk the request somewhere else with the API key attached.
- **Bounded** — a 5-second `AbortSignal.timeout`.
- **The provider's own message never reaches a browser** — it can quote the
  recipient address back. The status is logged; the client gets a generic error.

## What is deliberately NOT sent

No status-change emails ("your order is baking", "out for delivery"), no
marketing, no abandoned-cart mail. There is no scheduler, no queue and no
background worker in this system, and adding one is a separate decision with its
own cost. The order confirmation is sent inline after the commit precisely
because it needs no infrastructure.

If status emails are wanted later, `sendOrderConfirmation` in
`backend/mailer.js` is the shape to copy, and the place to call from is the
transaction in `repo/orders.js` `changeOrderStatus` — after the commit, not
inside it, and with the same swallow-and-log treatment.

## Cost

Brevo's free tier is 300 emails/day at time of writing. One order with an email
address is one message; one sign-in is one message. A day of 100 orders where
half the customers leave an address is roughly 50 sends.
