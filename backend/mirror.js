/**
 * Live in-memory copies of the collections the site reads most.
 *
 * Why this exists: Firestore lives in eur3 and every read is a network round
 * trip, measured at ~250ms from the server on 2026-09-24. The menu took two of
 * them, the dashboard overview sixteen, and an order search read up to five
 * thousand documents per keystroke. A bakery's whole catalogue, customer list
 * and order book fit comfortably in memory, so instead each mirrored collection
 * is held here and kept current by a Firestore real-time listener. A read is
 * then a Map lookup: no round trip and no per-read bill.
 *
 * Consistency, which is the whole difficulty:
 *
 *   - The listener delivers every change made anywhere — this process, a
 *     console edit, a seed script — usually well under a second later.
 *   - That "later" is not good enough for this process's own writes: an
 *     operator who marks an order baking and is shown it still "ordered" has
 *     been shown a lie. So every write the application makes to a mirrored
 *     collection is followed by `refresh()`, which re-reads exactly the
 *     documents it touched and applies them before the request returns.
 *   - Two sources can race. Each entry carries the version it was read at (the
 *     document's updateTime, or the snapshot readTime for a deletion) and an
 *     older version never overwrites a newer one, whichever arrives last.
 *
 * What the mirror is NOT used for: anything inside a transaction. Prices,
 * stock, promo limits and order totals are read with `tx.get` exactly as
 * before, so money is never decided from a copy.
 *
 * If the listener is not ready — booting, or dropped and reconnecting — `live()`
 * returns null and every caller falls back to reading Firestore directly, which
 * is the code path this replaced. Slower, never wrong.
 *
 * READ_MIRROR=off switches the whole thing off.
 */

import { collections, onClose } from './firestore.js';

const RETRY_MS = [1000, 2000, 5000, 15000, 30000];

const isOff = () => String(process.env.READ_MIRROR ?? '').toLowerCase() === 'off';

/** -1, 0 or 1 for two Firestore Timestamps (or nulls, which sort first). */
function compare(a, b) {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  if (a.seconds !== b.seconds) return a.seconds < b.seconds ? -1 : 1;
  if (a.nanoseconds !== b.nanoseconds) return a.nanoseconds < b.nanoseconds ? -1 : 1;
  return 0;
}

class Mirror {
  constructor(name, reference) {
    this.name = name;
    this.reference = reference;
    /** id → { version, data } where data is null for a known deletion. */
    this.entries = new Map();
    this.ready = false;
    this.unsubscribe = null;
    this.retry = null;
    this.failures = 0;
    /** Bumped on every applied change, so derived views know to rebuild. */
    this.generation = 0;
    this.derived = new Map();
  }

  start() {
    if (this.unsubscribe || this.retry || isOff()) return;
    let first = true;
    this.unsubscribe = this.reference().onSnapshot((snapshot) => {
      this.failures = 0;
      if (first) {
        // The first snapshot is the whole collection: authoritative, including
        // for what is absent from it.
        first = false;
        this.applyAll(snapshot.docs, snapshot.readTime);
        this.ready = true;
        return;
      }
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') this.apply(change.doc.id, snapshot.readTime, null);
        else this.apply(change.doc.id, change.doc.updateTime, change.doc.data());
      }
    }, (error) => {
      // The SDK has already given up on this listener. Serve from Firestore
      // directly until a new one has caught up.
      this.ready = false;
      this.unsubscribe = null;
      const wait = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
      this.failures += 1;
      console.warn(JSON.stringify({
        event: 'mirror_listener_error', collection: this.name, code: error?.code ?? 'UNKNOWN', retryMs: wait,
      }));
      this.retry = setTimeout(() => { this.retry = null; this.start(); }, wait);
      this.retry.unref?.();
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ready = false;
    this.entries.clear();
    this.derived.clear();
    this.generation += 1;
  }

  /** Apply one document version, unless something newer is already held. */
  apply(id, version, data) {
    const held = this.entries.get(id);
    if (held && compare(held.version, version) > 0) return false;
    if (held && compare(held.version, version) === 0 && (held.data === null) === (data === null)) return false;
    this.entries.set(id, { version, data });
    this.generation += 1;
    return true;
  }

  /** A full read: every document present, and everything else gone as of `readTime`. */
  applyAll(docs, readTime) {
    const present = new Set();
    for (const doc of docs) {
      present.add(doc.id);
      this.apply(doc.id, doc.updateTime, doc.data());
    }
    for (const id of [...this.entries.keys()]) {
      if (!present.has(id)) this.apply(id, readTime, null);
    }
  }

  /**
   * Re-read these documents and apply them now. Called after every write this
   * process makes, so the writer's next read already shows its own change.
   * Best effort: if the re-read fails the listener still delivers the change.
   */
  async refresh(ids) {
    if (!this.unsubscribe && !this.ready) return;
    const unique = [...new Set(ids.filter(Boolean).map(String))];
    if (!unique.length) return;
    try {
      const reference = this.reference();
      const snapshots = await reference.firestore.getAll(...unique.map((id) => reference.doc(id)));
      for (const snapshot of snapshots) {
        this.apply(snapshot.id, snapshot.exists ? snapshot.updateTime : snapshot.readTime,
          snapshot.exists ? snapshot.data() : null);
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'mirror_refresh_failed', collection: this.name, code: error?.code ?? 'UNKNOWN' }));
    }
  }

  /** Read the whole collection now and make it authoritative. */
  async sync() {
    if (isOff()) return;
    this.start();
    const snapshot = await this.reference().get();
    this.applyAll(snapshot.docs, snapshot.readTime);
    this.ready = true;
  }

  /** The document's data, or null. Only meaningful when `ready`. */
  get(id) {
    return this.entries.get(String(id))?.data ?? null;
  }

  /**
   * Every present document as `[id, data]`, in document-id order — the order a
   * plain Firestore `get()` returns, which callers' stable sorts break ties by.
   * Cached until the next change.
   */
  docs() {
    return this.derive('docs', () => {
      const rows = [];
      for (const [id, entry] of this.entries) if (entry.data) rows.push([id, entry.data]);
      return rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    });
  }

  /**
   * A value computed from the whole collection, rebuilt only after a change.
   * Callers must treat the result as read-only: it is shared between requests.
   */
  derive(key, build) {
    // Everything derived from an older generation is dead; dropping it here
    // keeps keys that embed a date or a parameter from piling up.
    if (this.derivedGeneration !== this.generation) {
      this.derived.clear();
      this.derivedGeneration = this.generation;
    }
    const held = this.derived.get(key);
    if (held && held.generation === this.generation) return held.value;
    const value = build();
    this.derived.set(key, { generation: this.generation, value });
    return value;
  }
}

/**
 * The single settings document is mirrored as a one-document collection, so it
 * follows exactly the same rules as everything else.
 */
const mirrors = {
  categories: new Mirror('categories', () => collections.categories()),
  products: new Mirror('products', () => collections.products()),
  promos: new Mirror('promos', () => collections.promos()),
  settings: new Mirror('settings', () => collections.settings()),
  customers: new Mirror('customers', () => collections.customers()),
  orders: new Mirror('orders', () => collections.orders()),
};

onClose(() => { for (const mirror of Object.values(mirrors)) mirror.stop(); });

/**
 * The mirror for `name` if it can answer right now, otherwise null — in which
 * case the caller reads Firestore itself. Starts the listener on first use.
 */
export function live(name) {
  const mirror = mirrors[name];
  if (isOff()) return null;
  mirror.start();
  return mirror.ready ? mirror : null;
}

/**
 * A token that changes whenever any of these collections does, or null if one
 * of them cannot answer. For caching a value computed across collections.
 */
export function versionOf(...names) {
  const parts = [];
  for (const name of names) {
    const mirror = live(name);
    if (!mirror) return null;
    parts.push(mirror.generation);
  }
  return parts.join(':');
}

/** After a write: make this process's next read see it. */
export async function refresh(name, ids) {
  await mirrors[name].refresh(Array.isArray(ids) ? ids : [ids]);
}

/** Start every listener. Called at boot so the first visitor is not the one who waits. */
export function startAll() {
  if (isOff()) return;
  for (const mirror of Object.values(mirrors)) mirror.start();
}

/**
 * Read every mirrored collection now. For tests, which write fixtures straight
 * into Firestore and then immediately ask the API about them — a sequence the
 * listener alone would win only most of the time.
 */
export async function syncAll() {
  await Promise.all(Object.values(mirrors).map((mirror) => mirror.sync()));
}

/** Whether each listener is serving, for /api/health-style diagnostics. */
export function status() {
  return Object.fromEntries(Object.entries(mirrors).map(([name, mirror]) => [name, {
    ready: mirror.ready, documents: mirror.docs().length,
  }]));
}
