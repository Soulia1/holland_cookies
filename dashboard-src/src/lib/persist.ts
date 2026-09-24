/**
 * The dashboard's read cache, kept on disk so a reload — or opening the
 * dashboard tomorrow — starts from what was last on screen instead of from a
 * spinner. The in-memory cache in api.ts stays the source every page reads;
 * this only saves it and gives it back at boot.
 *
 * IndexedDB rather than localStorage: an order book is megabytes, and
 * localStorage is both capped around 5 MB and synchronous on the main thread.
 *
 * Everything here is best effort. Private browsing, a full disk, or a browser
 * that blocks storage simply means the dashboard behaves as it did before this
 * existed — every failure is swallowed and nothing waits on a write.
 *
 * It holds customer names, phones and addresses, so it is emptied on sign-out,
 * on any 401, and whenever the session check at boot says there is no session.
 */

const DATABASE = "holland-dashboard";
const STORE = "reads";
/** Bump to discard everything saved by an older build whose shapes differ. */
const VERSION = 1;

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  opening ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE, VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run(mode: IDBTransactionMode, work: (store: IDBObjectStore) => void): Promise<void> {
  return open().then((db) => new Promise<void>((resolve) => {
    if (!db) return resolve();
    try {
      const tx = db.transaction(STORE, mode);
      work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  }));
}

/**
 * Bumped by every clear. A read that began before a clear must not put back
 * what the clear removed — the sign-out it raced would be undone.
 */
let epoch = 0;

/** Everything saved, or an empty map. Resolves within `timeoutMs` regardless. */
export function loadSaved(timeoutMs = 400): Promise<Map<string, unknown>> {
  const startedAt = epoch;
  const read = open().then((db) => new Promise<Map<string, unknown>>((resolve) => {
    const saved = new Map<string, unknown>();
    if (!db) return resolve(saved);
    try {
      const tx = db.transaction(STORE, "readonly");
      const cursor = tx.objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        saved.set(String(at.key), at.value);
        at.continue();
      };
      tx.oncomplete = () => resolve(startedAt === epoch ? saved : new Map());
      tx.onerror = () => resolve(new Map());
    } catch {
      resolve(new Map());
    }
  }));
  const giveUp = new Promise<Map<string, unknown>>((resolve) => setTimeout(() => resolve(new Map()), timeoutMs));
  return Promise.race([read, giveUp]);
}

// Writes are gathered and flushed together once the page is idle, so a burst of
// reads (the overview makes several at once) is one transaction, and no
// structured clone of a large value runs in the middle of a keystroke.
const pending = new Map<string, unknown>();
let flushScheduled = false;
const DELETE = Symbol("delete");

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const flush = () => {
    flushScheduled = false;
    const batch = [...pending];
    pending.clear();
    void run("readwrite", (store) => {
      for (const [key, value] of batch) {
        if (value === DELETE) store.delete(key);
        else store.put(value, key);
      }
    });
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(flush, { timeout: 2000 });
  else setTimeout(flush, 200);
}

export function save(key: string, value: unknown): void {
  pending.set(key, value);
  scheduleFlush();
}

export function remove(key: string): void {
  pending.set(key, DELETE);
  scheduleFlush();
}

export function clearSaved(): void {
  epoch += 1;
  pending.clear();
  void run("readwrite", (store) => store.clear());
}
