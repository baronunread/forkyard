import { Banner, Button, Empty, Select, Table } from "@cloudflare/kumo";
import { Lightning } from "@phosphor-icons/react";
import { useState } from "react";
import { call, client, yardRoute, type BenchRuns } from "../lib/api";
import { useAsync } from "../lib/data";
import { toastError, toasts } from "../lib/toast";

/** Fork latency and event latency, measured on this deployment. */
export function BenchPage() {
  const runs = useAsync(() => call(client.bench.$get()), []);
  const yards = useAsync(() => call(client.yards.$get()), []);
  const [yard, setYard] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const yardId = yard ?? yards.data?.[0]?.id ?? null;
  const latency = useAsync(() => (yardId ? call(yardRoute.latency.$get({ param: { yard: yardId } })) : Promise.resolve(null)), [yardId]);

  const run = async (n: number) => {
    if (!yardId) return;
    setBusy(n);
    try {
      const r = await call(client.bench.fork.$post({ json: { yardId, concurrency: n } }));
      toasts.add({ title: `Forked ${n}× concurrently`, description: `p50 ${r.stats.p50} ms · p95 ${r.stats.p95} ms · p99 ${r.stats.p99} ms`, variant: "success" });
      runs.reload();
    } catch (e) {
      toastError(e, "Benchmark failed");
    } finally {
      setBusy(null);
    }
  };

  const forkRuns = (runs.data ?? []).filter((r) => r.kind === "fork");
  const eventRuns = (runs.data ?? []).filter((r) => r.kind !== "fork");
  return (
    <div className="fy-scroll mx-auto h-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="fy-h1">Benchmarks</h1>
        <p className="mt-1 text-kumo-subtle">
          Forking is Forkyard's heartbeat: every task spawns several. These numbers come from this deployment (<code>/api/bench/fork</code>,{" "}
          <code>scripts/bench-*.ts</code>). Bench forks are deleted immediately.
        </p>
      </div>
      <div className="fy-card space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label="Yard"
            className="w-56"
            value={yardId ?? undefined}
            onValueChange={(v) => setYard(String(v))}
            items={Object.fromEntries((yards.data ?? []).map((y) => [y.id, y.name]))}
            placeholder="Pick a yard"
          />
          {[1, 5, 20, 50].map((n) => (
            <Button key={n} icon={<Lightning />} loading={busy === n} disabled={!yardId || busy !== null} onClick={() => run(n)}>
              Fork ×{n}
            </Button>
          ))}
        </div>
        <ResultsTable runs={forkRuns} />
      </div>

      <div className="fy-card space-y-3 p-4">
        <h2 className="fy-h3">Event latency (push → visible)</h2>
        {eventRuns.length ? <ResultsTable runs={eventRuns} /> : <p className="text-sm text-kumo-subtle">Run <code>pnpm bench:events</code> to record end-to-end numbers.</p>}
        {latency.data && (
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <div className="font-medium">Live path (Queue → DO → WebSocket), server side</div>
              <Stats s={latency.data.live.stats} />
            </div>
            <div>
              <div className="font-medium">K2 path (DO → K2 → pull consumer)</div>
              {latency.data.k2.configured ? <Stats s={latency.data.k2.stats} /> : <p className="text-kumo-subtle">K2 not configured on this deployment.</p>}
            </div>
          </div>
        )}
      </div>
      {runs.error && <Banner variant="error" title="Could not load runs" description={runs.error.message} />}
    </div>
  );
}

function Stats({ s }: { s: { n: number; p50: number; p95: number; p99: number } }) {
  if (!s.n) return <p className="text-kumo-subtle">no samples yet</p>;
  return (
    <p className="font-mono text-xs">
      n={s.n} p50={s.p50}ms p95={s.p95}ms p99={s.p99}ms
    </p>
  );
}

function ResultsTable({ runs }: { runs: BenchRuns }) {
  if (!runs.length) return <Empty size="sm" title="No runs yet" />;
  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Run</Table.Head>
          <Table.Head>Mode</Table.Head>
          <Table.Head>N</Table.Head>
          <Table.Head>p50</Table.Head>
          <Table.Head>p95</Table.Head>
          <Table.Head>p99</Table.Head>
          <Table.Head>When</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {runs.map((r) => (
          <Table.Row key={r.id}>
            <Table.Cell>{r.label}</Table.Cell>
            <Table.Cell>{r.mode}</Table.Cell>
            <Table.Cell className="tabular-nums">{r.concurrency}</Table.Cell>
            <Table.Cell className="font-mono tabular-nums">{fmt(r.stats.p50)}</Table.Cell>
            <Table.Cell className="font-mono tabular-nums">{fmt(r.stats.p95)}</Table.Cell>
            <Table.Cell className="font-mono tabular-nums">{fmt(r.stats.p99)}</Table.Cell>
            <Table.Cell className="text-xs text-kumo-subtle">{new Date(r.createdAt).toLocaleString()}</Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

function fmt(n: number | undefined): string {
  return n === undefined ? "–" : `${n} ms`;
}

