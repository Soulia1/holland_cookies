/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // The API runs as its own process in development. In production the Express
  // server serves this bundle and the API from one origin, so nothing is
  // proxied and `VITE_API_BASE` stays empty.
  //
  // The target is configurable because `vite preview` inherits this proxy, and
  // the end-to-end storefront suite runs against preview while the real API is
  // on 3100, not the dev port. Left hardcoded to 3000, every page load in that
  // suite fired an ECONNREFUSED for `/api/account/me` into the browser console —
  // which the "no console errors" homepage test then correctly failed on, for a
  // reason that had nothing to do with the homepage.
  server: {
    proxy: {
      "/api": {
        target: process.env.HOLLAND_API_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: process.env.HOLLAND_API_TARGET || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  // Unit tests only. `e2e/` is Playwright — its `test()` is a different function
  // with a different signature, and Vitest collecting those files reports three
  // spurious failures that have nothing to do with the code under test.
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
  build: {
    target: "es2020",
    // Keep the motion layer out of the entry chunk. The splash and the static
    // first screen must not wait on Framer Motion, which is only ever needed
    // once something is opened.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("framer-motion")) return "motion";
        },
      },
    },
  },
});
