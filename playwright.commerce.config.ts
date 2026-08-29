import { defineConfig, devices } from "@playwright/test";

/**
 * The commerce suite.
 *
 * A separate config because these tests need the *Express* server, not the
 * static preview the other suites run against: they place real orders, which
 * means a real API and a real database. The storefront suite deliberately does
 * not — it tests the page, and pointing it at a stateful backend would make
 * layout tests depend on the order table.
 *
 * `DATABASE_PATH` is an isolated file, so a run cannot write into the shop's
 * real data. It is also why `workers: 1`: the tests assert on order references,
 * which come from a shared counter.
 */
import path from "node:path";

const SERVER_LOG = path.resolve("data/e2e-server.log");
process.env.HOLLAND_E2E_LOG = SERVER_LOG;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(commerce|account|receipt)\.spec\.ts$/,
  timeout: 45_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  webServer: {
    // Built first: the server serves `dist`, so an unbuilt tree would test
    // whatever bundle happened to be lying there from a previous run.
    // The log is where the sign-in code lands in development, and the account
    // suite reads it from there — the same thing a developer does by hand.
    command: "npm run build && node backend/test/e2e-server.js > data/e2e-server.log 2>&1",
    url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  // Passed to the suite rather than hardcoded there, so the path lives in one
  // place and the tests fail loudly if it is ever not set.
  ...{},
  use: {
    browserName: "webkit",
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "iphone", use: { ...devices["iPhone 13"] } },
  ],
});
