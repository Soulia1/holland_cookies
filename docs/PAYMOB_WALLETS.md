# Paymob cards and mobile wallets

The hosted checkout receives all configured integration IDs, so customers can
switch between Card and Wallet on Paymob's page. The shop has one Paymob
option alongside cash; the signed payment callback records the method used.

For the Holland Cookies account, verified on 2026-10-06:

```dotenv
PAYMENTS_ONLINE=paymob
PAYMOB_INTEGRATION_IDS=5953699,5953698
PAYMOB_CARD_INTEGRATION_ID=5953699
PAYMOB_WALLET_INTEGRATION_ID=5953698
```

Keep merchant keys in the hosting environment or gitignored `.env`. The wallet
ID must be explicit and different from the card ID. ID order does not prove a
gateway's type. Additional methods such as ValU require their own enabled
integrations; they are not part of this change.

The live Mobile Wallet integration `5953698` has these callbacks configured:

- Processed: `https://holland-cookies.com/api/payments/paymob/webhook`
- Response: `https://holland-cookies.com/api/payments/paymob/return`

Only a verified server callback marks a real order paid. A browser return alone
does not settle an order.

## Local verification

Set `PAYMENTS_ONLINE=mock` for local simulator testing. Start Firestore with Java
21 or newer (`npm run emulators`), build (`npm run build`), and run
`npm run test:paymob:e2e`. This covers card and wallet success, switching methods,
declines, reload, browser Back, retry, receipts and cart clearing on desktop and
phone. Run `npm run test:backend` and `npm run test:security` against the emulator
for callback, order and security checks.

With live keys, opening a hosted checkout can verify the Card and Wallet picker
and wallet number form. Completing a live payment requires a wallet holder;
simulated success does not prove live wallet authorization or settlement.
