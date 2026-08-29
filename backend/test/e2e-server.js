/**
 * The server the end-to-end commerce suite runs against.
 *
 * A separate entry point rather than a flag on `server.js`, because the one
 * thing it must guarantee is that the suite cannot touch the real shop
 * database, and the safest way to guarantee that is for the path to be set here
 * — before anything imports the database module — rather than hoped for from
 * the environment.
 *
 * Everything else is the real server: the real routes, the real order
 * transaction, the real validation. A test double would prove the double works.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', '..', 'data');
const dbPath = path.join(dataDir, 'e2e.db');

// Set before `server.js` (and therefore `db.js`) is imported. A dynamic import
// below is what makes that ordering possible at all: a static `import` would be
// hoisted above these lines and the database would already be open on the
// default path. That exact mistake is what the tripwire in the unit suite
// exists to catch.
fs.mkdirSync(dataDir, { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  // A fresh database per run, so order references start from a known number
  // and one run cannot see another's orders.
  fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

process.env.DATABASE_PATH = dbPath;
process.env.PORT = '3100';
process.env.ADMIN_KEY = 'e2e-admin-key-0123456789abcdefghijkl';
process.env.JWT_SECRET = 'e2e-jwt-secret-0123456789abcdefghijkl';
process.env.NODE_ENV = 'production';
// Production configuration, served over plain http on localhost. Saying so
// explicitly is what keeps `upgrade-insecure-requests` and `Secure` cookies —
// both of which would break this server completely — switched off.
process.env.HTTPS_ORIGIN = 'false';
// Sign-in codes are printed to this process's stdout rather than emailed —
// there is no mail provider in a test run, and the account suite reads them
// back out of the log. Named explicitly so production can never fall into it.
process.env.MAIL_TRANSPORT = 'console';

const { seed } = await import('../seed.js');
await seed();

// Predictable delivery pricing, and one promo code the suite can rely on.
const db = await import('../db.js');
db.get().prepare(`
  UPDATE settings SET delivery_fee = 40, free_delivery_over = 600, accepting_orders = 1
  WHERE id = 1
`).run();
db.get().prepare(`
  INSERT OR REPLACE INTO promos (code, type, value, min_subtotal, max_uses, active)
  VALUES ('E2E10', 'percent', 10, 0, 0, 1)
`).run();

await import('../server.js');
