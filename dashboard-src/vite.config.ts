import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";

const ROOT = import.meta.dirname;

/**
 * The dashboard is its own Vite app, mirroring Scooby's arrangement.
 *
 * Separate from the storefront because it shares nothing with it: different
 * fonts, different palette, different audience, and — most importantly — a
 * customer must never download the admin bundle. Two apps, one Express server,
 * one origin.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(ROOT, "src"),
      // Pricing is shared with the backend and the storefront. Three copies of
      // this arithmetic is precisely what shared/pricing.mjs exists to prevent.
      "@shared": path.resolve(ROOT, "../shared"),
    },
  },
  root: ROOT,
  base: "/dashboard/",
  build: {
    outDir: path.resolve(ROOT, "../dist-dashboard"),
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
