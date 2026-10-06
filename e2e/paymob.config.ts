import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

export default defineConfig({
  testDir: ".", testMatch: "paymob.spec.ts", workers: 1, timeout: 45_000,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  webServer: {
    cwd: path.resolve(import.meta.dirname, ".."),
    command: "node backend/test/e2e-server.js", url: "http://127.0.0.1:3100/api/health",
    reuseExistingServer: false, timeout: 120_000,
    env: { PAYMENTS_ONLINE: "mock", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
  },
  projects: [
    { name: "paymob-desktop", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "paymob-phone", use: { ...devices["Pixel 7"], browserName: "chromium" } },
  ],
});
