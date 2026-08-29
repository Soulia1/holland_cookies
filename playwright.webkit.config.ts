import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /(splash-lifecycle|storefront|menu|bilingual-cart)\.spec\.ts$/,
  timeout: 45_000,
  workers: 1,
  retries: 0,
  reporter: "list",
  webServer: {
    // Host pinned to 127.0.0.1: left to itself vite binds localhost, which can
    // resolve to ::1, and the readiness poll below then waits on an address
    // nothing is listening on.
    command: "npx vite preview --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  use: {
    browserName: "webkit",
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // The tier that matters most: iOS Safari is where a hero and a boot
      // splash have real regressions.
      name: "iphone",
      use: { ...devices["iPhone 13"] },
    },
    {
      // Desktop WebKit gets the same splash/reduced-motion coverage. The
      // original defect this suite is modelled on was a reduced-motion bug, not
      // a mobile one — it reproduced here too.
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 } },
    },
  ],
});
