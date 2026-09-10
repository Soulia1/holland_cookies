# Repository audit — 2026-09-05

Starting commit: `a35e459`; starting branch: `main`. Work branch: `hardening/production-launch`. Before any edits, inspected status, branch, recent history, all tracked paths, runtime entrypoints, route modules, database migrations, authentication, mail, pricing, deployment and test configuration.

Pre-existing user edits: `src/App.tsx`, `src/data/menu.ts`, `src/index.css`, `src/lib/i18n.tsx`, `src/pages/MenuPage.tsx`. Preserve these; do not include them in hardening commits.

## Architecture and entrypoints

| Area | Implementation / finding |
| --- | --- |
| Storefront | React 19, TypeScript, Vite, custom client router, bilingual English/Arabic; static HTML plus client rendering |
| Admin | Separate React/Vite application under `/dashboard`; wouter, Radix, Tailwind, charts |
| API | Express 5, `backend/server.js`, four route modules; same-origin JSON API |
| Data | Single synchronous better-sqlite3 connection, WAL, foreign keys, 5 second busy timeout; embedded sequential migrations in db.js |
| Authentication | Admin shared key exchanged for signed HttpOnly JWT; customer emailed OTP using scrypt then JWT; originally no server revocation |
| Orders | Guest checkout, phone/reference tracking, email ownership claims, transactional pricing/customer/items/coupon/idempotency writes |
| Payments | Cash and a nominal card enum; no provider integration, no payment initiation, no webhooks or refunds |
| Email | Brevo HTTP API, originally no timeout; console fallback can be enabled in production |
| Images | Public raster files; admin image picker produces data URLs incompatible with existing 500 character server limit; no backend upload route |
| Deployment | Railway/Nixpacks, no existing Dockerfile, reverse-proxy config or CI workflow; persistent SQLite volume required |
| Caching | Compression, hashed bundles, originally one-year caching for every non-HTML file including unhashed images |
| Logging | Console output; no audit trail, no external error/uptime monitor configuration |
| Jobs | No scheduler, worker, queue or background mail/fulfillment job |
| Other interfaces | No GraphQL, WebSocket, RPC, server actions, XML parser, rich HTML editor, URL import/fetch, contact/newsletter, download/export or service worker |
| Third parties | Google Fonts styles/fonts; Brevo only backend fetch; no analytics/pixels/chat/payment scripts |
| Legacy | Ported Scooby/Firestore commentary and adapter helpers; historical migrations must remain; prove each removal by references and build |
| Existing tests | 28 Vitest tests and 20 Node transaction tests pass; two TS projects typecheck; both production builds pass |
| Existing supply chain | Committed npm lockfile; npm audit reports moderate qs vulnerabilities, no high/critical at baseline |

No real database, mail, payment or production endpoint is used for active testing. Test entrypoints must overwrite inherited credentials before importing dotenv/runtime modules. Deployment/account-side controls and actual backup history cannot be inferred from repository files.
