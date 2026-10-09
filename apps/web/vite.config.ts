import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * Dev: the Worker (FORKYARD_WORKER, default :8787; see scripts/dev.ts) serves the API, Better Auth (/api/auth), MCP and git. Keep the
 * browser's Host (changeOrigin: false) so the Worker's same-origin check and the
 * OAuth issuer both see the browser's origin (https://forkyard.localhost through portless).
 */
const worker: ProxyOptions = { target: process.env.FORKYARD_WORKER ?? "http://localhost:8787", changeOrigin: false };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    allowedHosts: [".localhost"],
    proxy: {
      "/api": { ...worker, ws: true },
      "/mcp": worker,
      "/git": worker,
      "/llms.txt": worker,
      "/AGENTS.md": worker,
      "/.well-known": worker,
      "/cdn-cgi": worker,
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
