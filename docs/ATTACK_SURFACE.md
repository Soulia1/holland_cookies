# Attack surface

Inventory from all Express route registrations and both frontend routers. Every API response is JSON/no-store. Defaults below: database access is parameterized SQLite; sensitive records use explicit serializers; all writes use bounded strict Zod object schemas. Query/param envelopes are validated centrally. `A` means admin session; `C` verified customer session; `P` anonymous. Limits are documented in `backend/security.js`; quotas apply before parsing and expensive work. Authentication/session changes and protected writes require a same-origin browser or the non-browser request header contract.

| Method | Path | Auth / role | Input | Output | DB | External | Limit class | Validation | Sensitive / risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET/HEAD | `/`, `/menu`, `/checkout`, `/account`, `/track` | P | Client route, language | Storefront shell | No | Google Fonts in browser | Edge | Known page paths | No server PII; DOM XSS/cache |
| GET/HEAD | `/dashboard` and known dashboard pages | P shell; A data | Client route | Admin shell | No | Fonts | Edge | Known paths | UI is public; data auth mandatory |
| GET/HEAD | `/assets/*`, `/img/*`, `/dashboard/assets/*` | P | Static path | Bundled JS/CSS/raster | No | No | Edge | Static root containment | Traversal/cache; no secrets/source maps |
| GET | `/api/health` | P | None | Liveness | No | No | public | Empty query | Availability; no internals |
| GET | `/api/ready` | P | None | Readiness | SELECT 1 | No | public | Empty query | Generic unavailable |
| GET | `/api/menu` | P | None | Visible catalogue | Read categories/products | No | public | Empty query | Bounded catalogue, output escaping |
| GET | `/api/menu/admin/products` | A | Page | Admin products | Read | No | public | Page schema | Admin config |
| POST | `/api/menu/admin/products` | A | Product fields | Product | Insert | No | admin-write | Product schema, category/discount | Price tamper, image URL |
| PATCH | `/api/menu/admin/products/:id` | A | ID + writable fields | Product | Update | No | admin-write | ID + merged business checks | Mass assignment |
| DELETE | `/api/menu/admin/products/:id` | A | ID | 204 | Delete with FK guards | No | admin-write | ID | Historical order integrity |
| GET | `/api/menu/admin/categories` | A | Page | Categories | Read | No | public | Page schema | Bounded |
| POST | `/api/menu/admin/categories` | A | Category fields | Category | Insert | No | admin-write | Category schema | Stored XSS, visibility |
| PATCH | `/api/menu/admin/categories/:id` | A | ID + writable fields | Success | Update | No | admin-write | Category patch | Mass assignment |
| DELETE | `/api/menu/admin/categories/:id` | A | ID | 204 | Delete if empty | No | admin-write | ID + FK | Data integrity |
| POST | `/api/orders` | P | Cart/contact/fulfillment/idempotency | Own new order | Atomic multi-table write | No | checkout | Strict checkout + catalogue/coupon/area | PII, replay, price/quantity manipulation |
| GET | `/api/orders/track/:reference` | P + matching phone | Reference/phone | Redacted tracking/history | Read | No | tracking | Reference + phone | Guessable credentials; residual privacy risk |
| GET | `/api/orders` | A | page/perPage/q/status | Order page | Read orders/items | No | public | Bounded pagination/search enum | Customer PII/BOLA |
| GET | `/api/orders/stats` | A | days | Aggregates | Read aggregates | No | report | Integer 1–365 | Expensive queries |
| GET | `/api/orders/:reference` | A | Reference | Full order/history | Read | No | public | Reference | PII/BOLA |
| PATCH | `/api/orders/:reference/status` | A | status/note | Order | Atomic status/history/audit | No | admin-write | Strict enum + transition | No payment status mutation |
| POST | `/api/admin/session` | P | key | HttpOnly session | Session insert | No | login | Strict key bounds | Brute force / session fixation |
| GET | `/api/admin/session` | P | Session cookie | Boolean | Session read | No | public | Token validation | No identity disclosure |
| DELETE | `/api/admin/session` | P | Session cookie | Success + expired cookie | Revoke | No | admin-write | Origin/token | Logout CSRF / replay |
| GET | `/api/admin/customers` | A | page/perPage/q | Customer page | Read | No | public | Pagination/search | PII |
| GET | `/api/admin/customers/:phone` | A | Phone/page | Customer/orders | Read | No | public | Phone/pagination | PII/BOLA |
| GET | `/api/admin/users` | A | page/perPage/q/refresh | Directory page + totals | Bounded reads/aggregates | No | report | Pagination/search | PII, resource exhaustion |
| GET | `/api/admin/promos` | A | Page | Promo definitions | Read | No | public | Pagination | Coupon confidentiality |
| POST | `/api/admin/promos` | A | Promo fields | Promo | Insert | No | admin-write | Strict + percentage/expiry | Discount abuse |
| PATCH | `/api/admin/promos/:code` | A | Code/patch | Success | Update | No | admin-write | Merged promo schema | Cross-field bypass |
| DELETE | `/api/admin/promos/:code` | A | Code | 204 | Delete | No | admin-write | Code | Quota reset risk |
| POST | `/api/admin/promos/validate` | P | code/subtotal | Advisory discount | Read | No | coupon | Strict schema | Enumeration; checkout recomputes |
| GET | `/api/admin/settings` | P | None | Public delivery settings | Read | No | public | Empty query | No secrets in serializer |
| PATCH | `/api/admin/settings` | A | Delivery/areas/open | Success | Update | No | admin-write | Strict bounded fields/array | Fee manipulation |
| POST | `/api/account/request-code` | P | email/lang | Generic send status | OTP quota/reservation | Brevo | OTP request + mailbox quota | Strict normalized email | Spam/DoS/mail outage |
| POST | `/api/account/verify-code` | P | email/code | Customer/session | Consume + profile/claim/session | No | OTP verify | Strict six digits | Replay/guessing |
| POST | `/api/account/signout` | P | Session | Success | Revoke | No | account-write | Origin/token | Logout replay |
| GET | `/api/account/me` | P or C | Session | Own profile/null | Read | No | public | Token + DB | PII/private cache |
| PATCH | `/api/account/profile` | C | Allowlisted profile fields | Own profile | Update own ID | No | account-write | Strict profile schema | Email/role mass assignment |
| GET | `/api/account/orders` | C | Page | Own orders/items | profile_id predicate | No | public | Pagination | A/B ownership |

## Absent interfaces

No server-side cart/search API (cart and menu filtering are browser-local), server actions/RPC, GraphQL, WebSocket, password/reset endpoint, payment/webhook, contact/newsletter, upload/multipart, remote-image fetch, arbitrary redirect, export/download, job trigger, XML or debug route. Attempts to access nonexistent API routes return 404. HEAD is intentionally supported for read routes; TRACE and unsupported methods are rejected. No old payment implementation was found to remove.

## Storage and information flows

SQLite contains profile emails, names, telephone numbers, delivery locations, order history, OTP KDF records, session hashes and operational audit metadata. Full records are never sent indiscriminately; the admin-only directory contains PII. Logs must exclude query strings, bodies, cookies and provider response bodies. Unhashed images are revalidated; only content-hashed assets receive immutable caching. Deployment versions are non-secret identifiers.
