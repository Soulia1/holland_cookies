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
