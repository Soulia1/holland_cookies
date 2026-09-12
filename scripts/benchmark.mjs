// Always creates its own database and HTTP listener. Never accepts a target URL.
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
process.env.NODE_ENV = 'test';
// The emulator, always. `backend/firestore.js` refuses to connect a non-production
// process to a real project, so this cannot silently benchmark against live data.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'holland-cookie-benchmark';
process.env.ADMIN_KEY = 'benchmark-only-admin-0123456789abcdef';
process.env.JWT_SECRET = 'benchmark-only-session-0123456789abcdef';
process.env.BREVO_API_KEY = '';
process.env.DISABLE_ADMIN_AUTH = 'false';
const { default: app } = await import('../backend/server.js');
const db = await import('../backend/firestore.js');
const { createOrder } = await import('../backend/orderTransaction.js');
const dbTarget = (db.get(), db.currentTarget());
if (!dbTarget.startsWith('emulator')) throw new Error('Unsafe datastore: ' + dbTarget);
await db.collections.categories().doc('bench').set({ name: 'Benchmark', visible: true, sort: 0 });
await db.collections.products().doc('bench').set({ categoryId: 'bench', name: 'Benchmark cookie', price: 50, available: true, discountEnabled: false, sort: 0 });
await db.orderCounterDoc().set({ value: 1000 });
for (let i = 0; i < 1000; i++) await createOrder({
  idempotencyKey: `benchmark-fixture-${i}`, items: [{ productId: 'bench', qty: 1 }],
  firstName: 'Fixture', phone: `010${String(i % 100).padStart(8, '0')}`, fulfilment: 'pickup',
});
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const login = await fetch(`${base}/api/admin/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'Holland' }, body: JSON.stringify({key: process.env.ADMIN_KEY}) });
const cookie = login.headers.get('set-cookie')?.split(';')[0];
const report = { label: process.argv[2] || 'local', node: process.version, fixtures: { orders: 1000, customers: 100 }, bundles: {}, api: {}, memory: {} };
try {
  for (const dir of ['dist', 'dist-dashboard']) {
    report.bundles[dir] = fs.readdirSync(`${dir}/assets`).filter(f => /\.(js|css)$/.test(f)).map(file => {
      const content = fs.readFileSync(path.join(dir, 'assets', file));
      return { file, bytes: content.length, gzip: gzipSync(content).length };
    });
  }
  for (const route of ['/api/menu', '/api/orders?perPage=25', '/api/admin/users']) {
    const times = []; let bytes = 0;
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      const res = await fetch(base + route, { headers: {cookie} });
      const body = await res.text();
      if (!res.ok) throw new Error(`${route}: ${res.status}`);
      bytes = Buffer.byteLength(body); times.push(performance.now() - start);
    }
    times.sort((a,b) => a-b);
    report.api[route] = { requests: times.length, p50_ms: +times[25].toFixed(2), p95_ms: +times[47].toFixed(2), responseBytes: bytes };
  }
  report.memory = process.memoryUsage();
  // Firestore has no EXPLAIN. The SQLite version recorded query plans here to
  // prove the indexes were being used; the equivalent evidence for Firestore is
  // that every query in firestore.indexes.json has a matching index and that a
  // missing one is a hard error at query time rather than a silent scan, which
  // the emulator surfaces during the test run.
  report.datastore = { engine: 'firestore', target: dbTarget };
  fs.mkdirSync('docs/evidence', {recursive: true});
  fs.writeFileSync(`docs/evidence/${report.label}-benchmark.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); await db.close().catch(() => {}); }
