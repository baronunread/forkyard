import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

/**
 * Dev: the Worker on :8787 serves the API, Better Auth (/api/auth), MCP and git. Keep the
 * browser's Host (changeOrigin: false) so the Worker's same-origin check and the
 * OAuth issuer both see http://localhost:5173.
 */
const worker: ProxyOptions = { target: "http://localhost:8787", changeOrigin: false };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { ...worker, ws: true },
      "/mcp": worker,
      "/git": worker,
      "/llms.txt": worker,
      "/AGENTS.md": worker,
      "/.well-known": worker,
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
