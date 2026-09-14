import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * The end-to-end suite.
 *
 * This file did not exist before the pre-launch pass, and its absence was a
 * bug rather than a gap: `npm run test:e2e` runs a bare `playwright test`, which
 * with no `playwright.config.ts` present fell through to `vite.config.ts` and
 * died with "Vitest failed to access its internal state". The script had
 * therefore never run. The two specialised configs beside this one were the only
 * way any e2e test was ever executed, and each had to be named explicitly.
 *
 * The second thing this fixes: both existing configs pin `browserName: "webkit"`,
 * so the entire suite had **no Chromium coverage**. Every project below runs on
 * both engines.
 *
 * ## Two servers, because the specs need genuinely different things
 *
 * The storefront specs test the *page* — layout, motion, language direction,
 * the boot splash — against a static preview. Pointing them at a stateful
 * backend would make a layout assertion depend on the order table.
 *
 * The commerce specs place real orders, so they need the real Express server,
 * the real order transaction, and a real Firestore behind it. That server is
 * `backend/test/e2e-server.js`, which resets and seeds the emulator on boot.
 *
 * ## No business API is mocked
 *
 * §96 of the launch brief is explicit that e2e tests which mock the business
 * APIs do not count. Nothing here mocks the menu, the cart, the order pipeline
 * or the dashboard: the commerce projects drive a real browser against a real
 * server against a real (emulated) database. The only thing not real is the
 * outbound mail provider, which prints sign-in codes to the server log instead —
 * the same thing a developer does by hand.
 *
 * The emulator must already be running; `npm run test:e2e` starts one.
 */

const SERVER_LOG = path.resolve("data/e2e-server.log");
process.env.HOLLAND_E2E_LOG = SERVER_LOG;

const STATIC = /(splash-lifecycle|storefront|menu|bilingual-cart)\.spec\.ts$/;
const COMMERCE = /(commerce|account|receipt|dashboard-to-shop|admin-dashboard)\.spec\.ts$/;

const PREVIEW = "http://127.0.0.1:4173";
const SERVER = "http://127.0.0.1:3100";

/** §109 — the widths the shop is actually used at, phone through desktop. */
const VIEWPORTS = {
  phone: { width: 375, height: 812 },
  phoneLarge: { width: 430, height: 932 },
  tablet: { width: 768, height: 1024 },
  laptop: { width: 1024, height: 768 },
  desktop: { width: 1440, height: 900 },
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  // The commerce specs assert on order references, which come from a shared
  // counter, so they cannot run in parallel with each other.
  workers: 1,
  retries: 0,
  reporter: [["list"]],

  webServer: [
    {
      // Host pinned to 127.0.0.1: left to itself vite binds localhost, which can
      // resolve to ::1, and the readiness poll then waits on an address nothing
      // is listening on.
      command: "npx vite preview --port 4173 --strictPort --host 127.0.0.1",
      url: PREVIEW,
      // NOT reused. This server's behaviour depends on HOLLAND_API_TARGET below,
      // and reusing one that happens to be listening means silently inheriting
      // whatever proxy target *it* was started with. That is not hypothetical:
      // a preview server left running from an unrelated command was picked up
      // here, proxied /api to the dev port where nothing listens, and vite
      // turned the ECONNREFUSED into a 500 — which the "no console errors"
      // homepage test then failed on, intermittently, for a reason nowhere near
      // the homepage.
      reuseExistingServer: false,
      timeout: 60_000,
      // Preview inherits the dev proxy, whose default target is the dev API
      // port. Point it at the e2e server instead, or every page load fires an
      // ECONNREFUSED for `/api/account/me` into the console and the "no console
      // errors" homepage assertion fails for an unrelated reason.
      env: { HOLLAND_API_TARGET: SERVER },
    },
    {
      // The log is where the sign-in code lands when mail is disabled, and the
      // account suite reads it from there.
      command: "node backend/test/e2e-server.js > data/e2e-server.log 2>&1",
      url: `${SERVER}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],

  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    // --- storefront, static preview ------------------------------------------
    {
      name: "storefront-chromium-desktop",
      testMatch: STATIC,
      use: { browserName: "chromium", baseURL: PREVIEW, viewport: VIEWPORTS.desktop },
    },
    {
      name: "storefront-chromium-phone",
      testMatch: STATIC,
      use: { ...devices["Pixel 7"], browserName: "chromium", baseURL: PREVIEW },
    },
    {
      // iOS Safari is where a hero and a boot splash have real regressions, and
      // the original defect this suite is modelled on was a reduced-motion bug.
      name: "storefront-webkit-phone",
      testMatch: STATIC,
      use: { ...devices["iPhone 13"], baseURL: PREVIEW },
    },
    {
      name: "storefront-webkit-desktop",
      testMatch: STATIC,
      use: { browserName: "webkit", baseURL: PREVIEW, viewport: VIEWPORTS.desktop },
    },

    // --- commerce, real server + real Firestore ------------------------------
    {
      name: "commerce-chromium-desktop",
      testMatch: COMMERCE,
      use: { browserName: "chromium", baseURL: SERVER, viewport: VIEWPORTS.desktop },
    },
    {
      name: "commerce-chromium-phone",
      testMatch: COMMERCE,
      use: { ...devices["Pixel 7"], browserName: "chromium", baseURL: SERVER },
    },
    {
      name: "commerce-webkit-phone",
      testMatch: COMMERCE,
      use: { ...devices["iPhone 13"], baseURL: SERVER },
    },
  ],
});
