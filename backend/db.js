/**
 * The database.
 *
 * SQLite through better-sqlite3, rather than the Firestore this project's
 * reference implementation uses. Two reasons, and the second is the one that
 * matters:
 *
 *  1. Firestore needs a Google Cloud service account. There isn't one for
 *     Holland Cookies, so that route stops at "create a project first".
 *  2. The order pipeline is built on a real transaction — read the catalogue,
 *     re-price the order, allocate a number and write, all or nothing. SQLite
 *     gives that natively and synchronously. Firestore gives it too, but with
 *     a read-then-write ceremony that exists to work around a network.
 *
 * Everything here goes through this module rather than opening its own handle,
 * so there is one connection, one place the pragmas are set, and one place to
 * change when this becomes Postgres. The query surface the routes use is small
 * and ordinary SQL by design — nothing here is SQLite-specific except the
 * pragmas and the driver import.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// The repo is `"type": "module"`, so the backend is ESM like everything else.
// That costs one line here and saves a dynamic `await import()` everywhere the
// shared pricing module is used.
const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where the file lives.
 *
 * Resolved on first connection rather than at module load, and that is not a
 * style choice — it is a bug fix, for a bug that had already happened.
 *
 * ES module imports are hoisted and evaluated before any statement in the
 * importing file, so a test that opens with
 *
 *     process.env.DATABASE_PATH = ':memory:';
 *     import * as db from '../db.js';
 *
 * sets that variable *after* this module has run. When the path was a
 * module-level `const`, the test suite therefore ignored its own `:memory:`
 * setting and wrote its fixtures — a category called "plain", a product called
 * "Sale Item" — straight into the real shop database. It was caught because
 * those turned up in the live API response, but nothing about the tests
 * themselves looked wrong: they passed, against real data they were quietly
 * corrupting.
 *
 * Reading it inside `connect()` means the variable is consulted at the moment
 * the first query happens, which is after any caller has had a chance to set
 * it, whatever the import order.
 */
function resolvePath() {
  return process.env.DATABASE_PATH || path.join(here, '..', 'data', 'holland.db');
}

let db = null;
let activePath = null;

function connect() {
  if (db) return db;

  activePath = resolvePath();
  if (activePath !== ':memory:') {
    fs.mkdirSync(path.dirname(activePath), { recursive: true });
  }
  db = new Database(activePath);

  // Write-ahead logging: readers do not block the writer, which matters the
  // moment the dashboard is polling orders while a customer is checking out.
  if (activePath !== ':memory:') db.pragma('journal_mode = WAL');
  // Off by default in SQLite, which would silently let an order row survive the
  // deletion of the product it points at.
  db.pragma('foreign_keys = ON');
  // Wait rather than throw if another connection holds the write lock.
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

/**
 * The schema.
 *
 * Applied on every boot and written to be idempotent, so deploying is just
 * starting the process. `user_version` records how far the file has been
 * migrated; each step runs once and in order.
 */
function migrate(database) {
  const current = database.pragma('user_version', { simple: true });

  const steps = [
    // 1 — the catalogue, orders, customers, discounts.
    () => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          name_ar     TEXT NOT NULL DEFAULT '',
          sort        INTEGER NOT NULL DEFAULT 0,
          visible     INTEGER NOT NULL DEFAULT 1,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- One row per logical product, with its translations alongside it.
        -- Deliberately NOT one row per language: a second row would double
        -- every price change, every stock toggle and every discount, and the
        -- two copies would drift the first time somebody edited only one.
        CREATE TABLE IF NOT EXISTS products (
          id              TEXT PRIMARY KEY,
          category_id     TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
          name            TEXT NOT NULL,
          name_ar         TEXT NOT NULL DEFAULT '',
          description     TEXT NOT NULL DEFAULT '',
          description_ar  TEXT NOT NULL DEFAULT '',
          note            TEXT NOT NULL DEFAULT '',
          note_ar         TEXT NOT NULL DEFAULT '',
          price           REAL NOT NULL CHECK (price >= 0),
          image           TEXT NOT NULL DEFAULT '',
          -- Three fields and no stored sale price; see shared/pricing.mjs.
          discount_enabled INTEGER NOT NULL DEFAULT 0,
          discount_type    TEXT NOT NULL DEFAULT 'percent',
          discount_value   REAL NOT NULL DEFAULT 0,
          available       INTEGER NOT NULL DEFAULT 1,
          sort            INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS products_category ON products(category_id, sort);

        -- Identified by phone: it is the field this business actually uses to
        -- find a customer, it is required at checkout, and it is the one a
        -- returning customer types the same way twice.
        CREATE TABLE IF NOT EXISTS customers (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          phone       TEXT NOT NULL UNIQUE,
          first_name  TEXT NOT NULL DEFAULT '',
          last_name   TEXT NOT NULL DEFAULT '',
          email       TEXT NOT NULL DEFAULT '',
          orders_count INTEGER NOT NULL DEFAULT 0,
          total_spent REAL NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS orders (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          reference     TEXT NOT NULL UNIQUE,
          customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
          first_name    TEXT NOT NULL,
          last_name     TEXT NOT NULL DEFAULT '',
          phone         TEXT NOT NULL,
          email         TEXT NOT NULL DEFAULT '',
          fulfilment    TEXT NOT NULL DEFAULT 'delivery',
          area          TEXT NOT NULL DEFAULT '',
          address       TEXT NOT NULL DEFAULT '',
          building      TEXT NOT NULL DEFAULT '',
          floor         TEXT NOT NULL DEFAULT '',
          apartment     TEXT NOT NULL DEFAULT '',
          landmark      TEXT NOT NULL DEFAULT '',
          notes         TEXT NOT NULL DEFAULT '',
          lang          TEXT NOT NULL DEFAULT 'en',
          -- Every figure computed by the server from the catalogue. Nothing a
          -- browser sent is stored here.
          subtotal      REAL NOT NULL,
          discount      REAL NOT NULL DEFAULT 0,
          delivery      REAL NOT NULL DEFAULT 0,
          total         REAL NOT NULL,
          promo_code    TEXT NOT NULL DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'ordered',
          payment_method TEXT NOT NULL DEFAULT 'cash',
          payment_status TEXT NOT NULL DEFAULT 'unpaid',
          payment_ref   TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at DESC);
        CREATE INDEX IF NOT EXISTS orders_phone ON orders(phone);
        CREATE INDEX IF NOT EXISTS orders_status ON orders(status);

        -- The name and price are copied onto the line rather than joined from
        -- the product. An order is a record of what was sold at the price it
        -- was sold for; renaming or repricing a cookie next month must not
        -- rewrite last month's receipts.
        CREATE TABLE IF NOT EXISTS order_items (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id  TEXT NOT NULL,
          name        TEXT NOT NULL,
          name_ar     TEXT NOT NULL DEFAULT '',
          note        TEXT NOT NULL DEFAULT '',
          unit_price  REAL NOT NULL,
          qty         INTEGER NOT NULL CHECK (qty > 0),
          line_total  REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS order_items_order ON order_items(order_id);

        CREATE TABLE IF NOT EXISTS order_status_history (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          status      TEXT NOT NULL,
          note        TEXT NOT NULL DEFAULT '',
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS order_history_order ON order_status_history(order_id);

        CREATE TABLE IF NOT EXISTS promos (
          code          TEXT PRIMARY KEY,
          type          TEXT NOT NULL DEFAULT 'percent',
          value         REAL NOT NULL,
          min_subtotal  REAL NOT NULL DEFAULT 0,
          max_uses      INTEGER NOT NULL DEFAULT 0,
          used_count    INTEGER NOT NULL DEFAULT 0,
          active        INTEGER NOT NULL DEFAULT 1,
          expires_at    TEXT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- One row, id 1. Delivery fee, thresholds, opening hours.
        CREATE TABLE IF NOT EXISTS settings (
          id                INTEGER PRIMARY KEY CHECK (id = 1),
          delivery_fee      REAL NOT NULL DEFAULT 0,
          free_delivery_over REAL NOT NULL DEFAULT 0,
          accepting_orders  INTEGER NOT NULL DEFAULT 1,
          areas             TEXT NOT NULL DEFAULT '[]',
          updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO settings (id) VALUES (1);

        -- Guards against a network retry or a double-tapped Pay button turning
        -- into two identical orders.
        CREATE TABLE IF NOT EXISTS order_idempotency (
          key         TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Order references are allocated from a counter rather than derived
        -- from the row id, so they stay contiguous and readable over the phone
        -- even after a deletion.
        CREATE TABLE IF NOT EXISTS counters (
          name  TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO counters (name, value) VALUES ('orders', 1000);
      `);
    },
    // 2 — adopt the shared status model.
    //
    // Holland shipped with `pending` / `out_for_delivery`; the dashboard ported
    // from Scooby is built on `ordered` / `in_transit`, and the status set is
    // now defined once in shared/orderStatus.mjs for both. Same six states and
    // the same flow, so this is a rename rather than a remodelling — but any
    // order already in the database has to come with it, history included.
    () => {
      database.exec(`
        UPDATE orders SET status = 'ordered'    WHERE status = 'pending';
        UPDATE orders SET status = 'in_transit' WHERE status = 'out_for_delivery';
        UPDATE order_status_history SET status = 'ordered'    WHERE status = 'pending';
        UPDATE order_status_history SET status = 'in_transit' WHERE status = 'out_for_delivery';
        UPDATE orders SET payment_status = 'unpaid' WHERE payment_status = 'pending';
      `);
    },
    // 3 — customer accounts: one-time codes and the profiles they unlock.
    () => {
      database.exec(`
        -- One live code per email. A new request replaces the previous row, so
        -- an old code stops working the moment a new one is sent.
        --
        -- The code itself is NEVER stored. Only a scrypt hash of it, with a
        -- per-row salt, so a copy of this table — an export, a stolen file — is
        -- not a list of working sign-in credentials.
        CREATE TABLE IF NOT EXISTS otp_codes (
          email        TEXT PRIMARY KEY,
          code_hash    TEXT NOT NULL,
          code_salt    TEXT NOT NULL,
          expires_at   TEXT NOT NULL,
          attempts     INTEGER NOT NULL DEFAULT 0,
          last_sent_at TEXT NOT NULL,
          -- Rolling counters for the per-address quota. Reset lazily when the
          -- window they belong to has passed.
          sent_hour    INTEGER NOT NULL DEFAULT 0,
          hour_start   TEXT NOT NULL,
          sent_day     INTEGER NOT NULL DEFAULT 0,
          day_start    TEXT NOT NULL
        );

        -- The account. Created on first successful sign-in; the email is proved
        -- by the code before this row exists, never merely typed.
        CREATE TABLE IF NOT EXISTS profiles (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT NOT NULL UNIQUE,
          full_name     TEXT NOT NULL DEFAULT '',
          phone         TEXT NOT NULL DEFAULT '',
          default_area  TEXT NOT NULL DEFAULT '',
          default_address TEXT NOT NULL DEFAULT '',
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Which orders belong to which account. An order placed as a guest is
        -- attached here once the same email is proved, which is why the link is
        -- its own table rather than a column set at checkout time.
        ALTER TABLE orders ADD COLUMN profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS orders_profile ON orders(profile_id);
        CREATE INDEX IF NOT EXISTS orders_email ON orders(email);
      `);
    },
    // 4 — repair history rows written between migrations 2 and 3.
    //
    // Migration 2 renamed `pending` to `ordered` everywhere, but the order
    // transaction kept writing the old name into the *first* history row for a
    // few commits after. Those orders therefore show the right status and a
    // timeline whose first step has no timestamp, because nothing in the
    // history matches `ordered`. Idempotent, so it costs nothing on a database
    // that never had the problem.
    () => {
      database.exec(`
        UPDATE order_status_history SET status = 'ordered'    WHERE status = 'pending';
        UPDATE order_status_history SET status = 'in_transit' WHERE status = 'out_for_delivery';
      `);
    },
  ];

  for (let version = current; version < steps.length; version += 1) {
    const step = steps[version];
    // Each migration is its own transaction: a step that fails half way leaves
    // the file at the previous version rather than in a shape no version
    // describes.
    database.transaction(step)();
    database.pragma(`user_version = ${version + 1}`);
  }
}

/** The connection, opened on first use. */
export function get() {
  return connect();
}

/** Close it. Used by the tests; the server never calls this. */
export function close() {
  if (db) {
    db.close();
    db = null;
    activePath = null;
  }
}

/** The file this connection actually opened. Null until the first query. */
export function currentPath() {
  return activePath;
}

export default { get, close, currentPath };
