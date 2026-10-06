# Paymob Unified Checkout

Implemented against the Unified Checkout redirection guide linked in
`Timeline plan_Holland_Cookies.pdf`, reviewed 6 October 2026.

## Railway setup

Add these variables to **holland_cookies / production** in Railway. The last
read-only check on 6 October found none configured. Keep secret values in Railway;
do not commit them or place them in frontend/VITE variables.

| Variable | Value |
| --- | --- |
| `PAYMENTS_ONLINE` | `paymob` |
| `PAYMOB_SECRET_KEY` | Egypt test secret key first; live key after Paymob approval |
| `PAYMOB_PUBLIC_KEY` | Matching Egypt test/live public key |
| `PAYMOB_HMAC_SECRET` | Merchant HMAC secret |
| `PAYMOB_INTEGRATION_IDS` | Comma-separated numeric IDs for the enabled card/wallet methods, matching the keys' mode |
| `PAYMOB_API_KEY` | Account API key for authenticated transaction inquiry/refund reconciliation |
| `APP_ORIGIN` | `https://holland-cookies.com` (already configured) |

For **every** enabled payment integration in the Paymob dashboard, configure:

- Transaction processed callback (POST): `https://holland-cookies.com/api/payments/paymob/webhook`
- Transaction response callback (GET): `https://holland-cookies.com/api/payments/paymob/return`

The intention also sends these URLs, but `notification_url` is supported only
for cards; wallets need the integration's dashboard callback. The callbacks must
be public HTTPS endpoints with no browser login or CSRF challenge.

Check the configuration without exposing credentials:

```powershell
railway run --service holland_cookies --environment production node scripts/paymob-check.mjs
```

Append `--provider` to validate the account API key using authentication only.
This check does not validate checkout keys or integration IDs and creates no charge.
Production refuses to start with online payments enabled and missing credentials.

## Flow and reconciliation

The backend prices an order, saves it unpaid, creates a payment intention, and
stores Paymob's order ID. The customer navigates to `https://eg.checkout.paymob.com/`.
After payment, the return route verifies the signature and redirects to checkout.
The same browser tab restores its saved reference/phone from session storage and
polls server payment status. The cart stays until payment is confirmed. Browser
Back, declines, reloads, and retry preserve the existing order.

Only authenticated server callbacks settle real payments. Matching uses the
signed Paymob order ID, not the unsigned merchant reference. The exact EGP amount,
integration, success, pending, and auth flags are checked. Authorization alone
does not mark the order paid. Online orders cannot advance through fulfillment
until paid; cancellation remains available. Callback retries cannot record the
same payment twice. Customer receipts and bakery email alerts are sent after
online payment is confirmed and use existing mail deduplication. An unpaid online
order does not send a misleading "paid" alert.
Unmatched callbacks return 503 so an early webhook can retry
after the intention is stored. Valid declines return 200 and keep the order unpaid.

Initiate refunds in the **Paymob dashboard**, including partial refunds. On refund
or void updates, the backend authenticates to Paymob and reads the original
transaction. HMAC does not cover `refunded_amount_cents`, so the webhook's value
is never trusted. Cumulative refund totals are monotonic, bounded by the charge,
and idempotent. Failed inquiry returns 503 for retry. Order detail shows refunded
and remaining payment amounts; paid revenue subtracts partial refunds. A full
refund marks the payment refunded. A stale successful charge cannot undo it.
Order receipt totals remain unchanged.

Signed transactions that fail amount/integration checks or reveal a second charge
are acknowledged without changing the order; investigate `payment_result` log
outcomes `amount_mismatch`, `refund_mismatch`, `integration_mismatch`, and
`duplicate_charge` before fulfillment.

## Acceptance tests from the PDF

Automated tests use the Firestore emulator, local mock checkout, and stubbed Paymob
API responses. They do not prove Paymob's actual delivery or acquiring behavior.

| Scenario | Automated coverage | Still required on Paymob test account |
| --- | --- | --- |
| Successful payment | Correct amount, signed webhook, dashboard status, desktop/phone receipt and cleared cart | Pay with Paymob test credentials and verify the merchant dashboard |
| Declined payment | Unpaid order, customer error, retry on the same order | Use Paymob's declined card scenario |
| Partial refund | API-confirmed refund total, remaining balance, repeated delivery, full refund and stale replay | Refund part of a successful test transaction in Paymob dashboard |
| Webhook URL | Signature rejection, HTTP 200 for handled deliveries, retry safety, early callback 503 | Confirm delivery to the deployed HTTPS endpoint for card and wallet |
| Redirection URL | Signed return, no settlement from real redirects, desktop/phone success/decline/Back/reload | Verify 3DS, success, failure and cancellation on the hosted checkout |

```powershell
npm run typecheck
npm run build
npm test
# Start Firestore emulator first:
npm run test:backend
npm run test:security
npm run test:paymob:e2e
```

Use `PAYMENTS_ONLINE=mock` only locally. Production rejects mock mode. Existing
cash checkout remains available while Paymob is disabled or not configured.

## Go live

After the Paymob integration team accepts the test-account scenarios and the
account manager approves go-live, replace test public/secret keys **and integration
IDs together** with their live counterparts. Keep HMAC/API credentials as provided
by Paymob. Deploy this branch, verify the callback settings, process the first
approved live transaction, and compare the storefront order with Paymob's dashboard.
Configure Paymob's reconciliation reports for the finance team. No deployment,
live charge, or refund has been performed by this implementation task.

## Sources

- [Unified Checkout URLs](https://developers.paymob.com/paymob-docs/developers/checkout-experiences/unified-checkout-redirection)
- [Create intention](https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention)
- [Callbacks and payment authority](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/transaction-callbacks)
- [HMAC field list](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback)
- [Transaction inquiry](https://developers.paymob.com/paymob-docs/developers/transaction-inquiry-apis/transaction-inquiry/by-transaction-id)
- [Refunds through Paymob dashboard](https://developers.paymob.com/paymob-docs/payments-and-features/managing-payments/refund)
- [Paymob's official inquiry Postman collection](https://github.com/PaymobAccept/API-Postman-Collections/blob/main/Transaction%20Inquiry%20API.postman_collection.json)
