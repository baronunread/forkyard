/**
 * Delete stale forks. Run before Artifacts billing starts (October 15, 2026),
 * and any time you want to reclaim storage. The hourly cron does the same for
 * closed tasks after FORK_TTL_HOURS.
 *
 *   bun run cleanup                         # forks of closed tasks older than 24h + leftover bench forks
 *   bun run cleanup --ttl=0                 # all forks of closed tasks, now
 *   bun run cleanup --abandon-open=72       # also abandon tasks still open after 72h (their forks go too)
 */
import { api, arg } from "./lib";

const ttlHours = Number(arg("ttl", "24"));
const abandon = arg("abandon-open");

const res = await api<{ abandoned: string[]; deletedForks: string[]; failedForks: string[]; deletedBenchForks: string[] }>("/admin/cleanup", {
  body: { ttlHours, abandonOpenOlderThanHours: abandon === undefined ? undefined : Number(abandon), sweepBench: true },
});
console.log(`abandoned tasks:     ${res.abandoned.length}${res.abandoned.length ? `  (${res.abandoned.join(", ")})` : ""}`);
console.log(`deleted forks:       ${res.deletedForks.length}`);
console.log(`deleted bench forks: ${res.deletedBenchForks.length}`);
if (res.failedForks.length) {
  console.error(`FAILED to delete:    ${res.failedForks.join(", ")}`);
  process.exit(1);
}
