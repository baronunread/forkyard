// wrangler dev needs the assets directory to exist; in dev the UI is served by Vite (:5173).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const dir = new URL("../apps/web/dist/", import.meta.url);
if (!existsSync(new URL("index.html", dir))) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    new URL("index.html", dir),
    '<!doctype html><meta charset="utf-8"><title>Forkyard</title><p style="font-family:system-ui">The Forkyard UI runs on <a href="http://localhost:5173">http://localhost:5173</a> during <code>pnpm dev</code>. Run <code>pnpm build</code> to serve it from the Worker.</p>',
  );
}
