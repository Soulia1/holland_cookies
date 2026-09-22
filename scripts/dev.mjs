/**
 * One command that gives you a working shop.
 *
 *     npm run dev
 *
 * Starts the Firestore emulator, seeds it if it is empty, starts the API, and
 * starts Vite — then shuts all of them down together on Ctrl+C.
 *
 * This exists because after the Firestore migration `npm run dev` started Vite
 * alone, which proxied /api to a backend nobody had started, and the shop loaded
 * with an empty menu and a console full of errors. Four things have to be
 * running in the right order for this app to work locally, and expecting anyone
 * to remember that — including me, next month — is how "it's broken" happens.
 *
 * Deliberately no `concurrently` dependency: this is ~100 lines of child_process
 * and a dependency that only runs on a developer's laptop is still a dependency
 * to audit, update and explain.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EMULATOR = '127.0.0.1:8080';
const API_PORT = 3000;
const PROJECT = 'holland-cookie-dev';

const env = {
  ...process.env,
  NODE_ENV: 'development',
  FIRESTORE_EMULATOR_HOST: EMULATOR,
  GCLOUD_PROJECT: PROJECT,
  PORT: String(API_PORT),
  // Sign-in codes print to this terminal rather than needing a mail provider.
  MAIL_TRANSPORT: 'console',
  // Long enough to satisfy the length rule, obviously not a secret. Production
  // rejects anything containing "example".
  ADMIN_KEY: process.env.ADMIN_KEY || 'local-development-only-admin-key-example',
  JWT_SECRET: process.env.JWT_SECRET || 'local-development-only-jwt-secret-example',
};

const children = [];
let shuttingDown = false;

function run(name, command, args, options = {}) {
  // A shell is needed on Windows to resolve `npx` (it is npx.cmd), and is
  // actively harmful for an absolute path: `process.execPath` is
  // "C:\Program Files\nodejs\node.exe", and through cmd.exe that becomes
  // 'C:\Program' is not recognized as an internal or external command.
  const needsShell = process.platform === 'win32' && !command.includes('\\') && !command.includes('/');
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: needsShell,
    env,
    ...options,
  });
  const tag = `[${name}]`;
  const write = (_stream) => (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) console.log(`${tag} ${line}`);
    }
  };
  child.stdout.on('data', write());
  child.stderr.on('data', write());
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`\n${tag} exited with code ${code}. Shutting everything down.\n`);
      stop(1);
    }
  });
  children.push({ name, child });
  return child;
}

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    try {
      // On Windows a plain kill leaves the emulator's Java child orphaned on
      // port 8080, and the next run fails with "port taken".
      if (process.platform === 'win32') spawn('taskkill', ['/pid', child.pid, '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 1500).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function waitFor(label, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(500);
  }
  console.error(`\nTimed out waiting for ${label}.\n`);
  stop(1);
}

const reachable = (url) => fetch(url, { signal: AbortSignal.timeout(1500) })
  .then(() => true).catch(() => false);

console.log('\n  Holland Cookies — local development\n');

// 1. Firestore emulator.
console.log('  starting the Firestore emulator …');
run('firestore', 'npx', ['firebase', 'emulators:start', '--only', 'firestore', '--project', PROJECT]);
await waitFor('the Firestore emulator', () => reachable(`http://${EMULATOR}`));
console.log('  emulator ready\n');

// 2. Seed, but only if the catalogue is empty — re-seeding on every start would
//    quietly undo whatever you were in the middle of editing.
const { collections } = await import('../backend/firestore.js');
Object.assign(process.env, { FIRESTORE_EMULATOR_HOST: EMULATOR, GCLOUD_PROJECT: PROJECT, NODE_ENV: 'development' });
const existing = await collections.products().limit(1).get();
if (existing.empty) {
  console.log('  the catalogue is empty — seeding it from src/data/menu.ts …');
  const { seed } = await import('../backend/seed.js');
  const result = await seed();
  console.log(`  seeded ${result.products} products across ${result.categories} categories\n`);
} else {
  console.log('  catalogue already seeded (npm run seed -- --force to reset it)\n');
}

// 3. The API.
console.log('  starting the API …');
run('api', process.execPath, ['backend/server.js']);
await waitFor('the API', () => reachable(`http://127.0.0.1:${API_PORT}/api/health`));
console.log('  API ready\n');

// 4. The storefront.
console.log('  starting Vite …\n');
run('vite', 'npx', ['vite', '--host', '127.0.0.1']);

await sleep(2500);
console.log(`
  ─────────────────────────────────────────────
    storefront   http://127.0.0.1:5173
    dashboard    http://admin.localhost:${API_PORT}   (build it first: npm run build:dashboard)
    API          http://127.0.0.1:${API_PORT}/api/menu
    emulator     http://${EMULATOR}

    admin key    ${env.ADMIN_KEY}
    sign-in codes print into this terminal
  ─────────────────────────────────────────────

  Ctrl+C stops all of it.
`);
