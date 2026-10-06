# WhatsApp order alert

Every new order sends one short WhatsApp message to the bakery's phone, beside
the email alert. It uses CallMeBot, a free relay. It is **not** Meta's Business
API: no delivery guarantee, and it can be throttled. The email stays the
reliable record; nothing in the order flow depends on this.

Off by default. It turns on when both variables are set.

| Variable | Value |
|---|---|
| `WHATSAPP_PHONE` | The number that registered with CallMeBot, with country code, e.g. `+201210004315` |
| `CALLMEBOT_APIKEY` | The key CallMeBot replied with |

Production refuses to boot if only one of the two is set.

## One-time registration (on the owner's phone)

1. Save CallMeBot's WhatsApp number as a contact. Name it **Online Orders (HC)**
   so the alerts show under that name.
2. Send it the sentence CallMeBot publishes at
   https://www.callmebot.com/blog/free-api-whatsapp-messages/ — the number and
   the sentence are on that page and change occasionally.
3. It replies with an API key. Put it in `CALLMEBOT_APIKEY`.

## What the message says

```
Online Orders (HC)
New order HC-1234
2 x Chocolate Cookie
Total: 240.00 EGP (cash)
Delivery
https://admin.holland-cookies.com/orders/HC-1234
```

No customer name, phone or address: CallMeBot only takes a GET, so the text
travels in a URL that ends up in logs. The dashboard link has the rest.

## Behaviour

- Independent of email: it works while `MAIL_TRANSPORT` is off.
- One message per order (the reference is claimed in `mailLog` as `whatsapp:<ref>`);
  a replayed checkout sends nothing.
- A failure is logged as `whatsapp_alert_failed` with a code only
  (`WHATSAPP_REFUSED`, `WHATSAPP_TIMEOUT`, `WHATSAPP_UNREACHABLE`) and never
  affects the order. The API key is never logged.
- Tests: `backend/test/whatsapp.test.js`.
