import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // The three.js lock scene (~136 KB gz) is lazy-loaded only on capable devices/connections.
    chunkSizeWarningLimit: 600,
  },
});
