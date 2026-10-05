import { Banner, Empty, Select } from "@cloudflare/kumo";
import { CaretDown, CaretUp, Lightning } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createColumnHelper, createSortedRowModel, rowSortingFeature, sortFn_alphanumeric, sortFn_basic, sortFn_datetime, tableFeatures, useTable } from "@tanstack/react-table";
import { useState } from "react";
import { Button, Card, cx } from "../components/ui";
import { call, client, type BenchRuns } from "../lib/api";
import { benchRunsQuery, latencyQuery, yardsQuery } from "../lib/queries";
import { toastError, toasts } from "../lib/toast";

/** Fork latency and event latency, measured on this deployment. */
export function BenchPage() {
  const runs = useQuery(benchRunsQuery);
  const yards = useQuery(yardsQuery);
  const qc = useQueryClient();
  const [yard, setYard] = useState<string | null>(null);
  const yardId = yard ?? yards.data?.[0]?.id ?? null;
  const latency = useQuery({ ...latencyQuery(yardId ?? ""), enabled: !!yardId });

  const fork = useMutation({
    mutationFn: (n: number) => call(client.bench.fork.$post({ json: { yardId: yardId!, concurrency: n } })),
    onSuccess: (r, n) => {
      toasts.add({ title: `Forked ${n}× concurrently`, description: `p50 ${r.stats.p50} ms · p95 ${r.stats.p95} ms · p99 ${r.stats.p99} ms`, variant: "success" });
      void qc.invalidateQueries({ queryKey: benchRunsQuery.queryKey });
    },
    onError: (e) => toastError(e, "Benchmark failed"),
  });

  const forkRuns = (runs.data ?? []).filter((r) => r.kind === "fork");
  const eventRuns = (runs.data ?? []).filter((r) => r.kind !== "fork");
  return (
    <div className="h-full overflow-y-auto [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-5xl space-y-6 p-8 max-sm:p-4">
        <div>
          <h1 className="text-h1">Benchmarks</h1>
          <p className="mt-1 text-body">
            Forking is Forkyard's heartbeat: every task spawns several. These numbers come from this deployment (<code>/api/bench/fork</code>, <code>scripts/bench-*.ts</code>).
            Bench forks are deleted immediately.
          </p>
        </div>
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label="Yard"
              className="w-56"
              value={yardId ?? null}
              onValueChange={(v) => setYard(String(v))}
              items={Object.fromEntries((yards.data ?? []).map((y) => [y.id, y.name]))}
              placeholder="Pick a yard"
            />
            {[1, 5, 20, 50].map((n) => (
              <Button key={n} icon={<Lightning />} loading={fork.isPending && fork.variables === n} disabled={!yardId || fork.isPending} onClick={() => fork.mutate(n)}>
                Fork ×{n}
              </Button>
            ))}
          </div>
          <RunsTable runs={forkRuns} />
        </Card>

        <Card className="space-y-4 p-4">
          <h2 className="text-h3">Event latency (push → visible)</h2>
          {eventRuns.length ? (
            <RunsTable runs={eventRuns} />
          ) : (
            <p className="text-sm text-body">
              Run <code>pnpm bench:events</code> to record end-to-end numbers.
            </p>
          )}
          {latency.data && (
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <div className="font-medium">Live path (Queue → DO → WebSocket), server side</div>
                <Stats s={latency.data.live.stats} />
              </div>
              <div>
                <div className="font-medium">K2 path (DO → K2 → pull consumer)</div>
                {latency.data.k2.configured ? <Stats s={latency.data.k2.stats} /> : <p className="text-body">K2 not configured on this deployment.</p>}
              </div>
            </div>
          )}
        </Card>
        {runs.error && <Banner variant="error" title="Could not load runs" description={runs.error.message} />}
      </div>
    </div>
  );
}

function Stats({ s }: { s: { n: number; p50: number; p95: number; p99: number } }) {
  if (!s.n) return <p className="text-body">no samples yet</p>;
  return (
    <p className="font-mono text-xs">
      n={s.n} p50={s.p50}ms p95={s.p95}ms p99={s.p99}ms
    </p>
  );
}

// ── runs table (TanStack Table v9: sortable, headless, Tailwind markup) ──

type Run = BenchRuns[number];
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic, alphanumeric: sortFn_alphanumeric, datetime: sortFn_datetime },
});
const col = createColumnHelper<typeof features, Run>();
const ms = (n: number | undefined) => (n === undefined ? "–" : `${n} ms`);
const columns = col.columns([
  col.accessor("label", { header: "Run", sortFn: "alphanumeric" }),
  col.accessor("mode", { header: "Mode", sortFn: "alphanumeric" }),
  col.accessor("concurrency", { header: "N", sortFn: "basic", meta: { numeric: true } }),
  col.accessor((r) => r.stats.p50, { id: "p50", header: "p50", sortFn: "basic", cell: (c) => ms(c.getValue()), meta: { numeric: true } }),
  col.accessor((r) => r.stats.p95, { id: "p95", header: "p95", sortFn: "basic", cell: (c) => ms(c.getValue()), meta: { numeric: true } }),
  col.accessor((r) => r.stats.p99, { id: "p99", header: "p99", sortFn: "basic", cell: (c) => ms(c.getValue()), meta: { numeric: true } }),
  col.accessor((r) => new Date(r.createdAt), { id: "when", header: "When", sortFn: "datetime", cell: (c) => c.getValue().toLocaleString() }),
]);

function RunsTable({ runs }: { runs: BenchRuns }) {
  const table = useTable({ features, columns, data: runs, initialState: { sorting: [{ id: "when", desc: true }] } });
  if (!runs.length) return <Empty size="sm" title="No runs yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id} className="border-b border-line">
              {g.headers.map((h) => {
                const sorted = h.column.getIsSorted();
                const numeric = (h.column.columnDef.meta as { numeric?: boolean } | undefined)?.numeric;
                return (
                  <th key={h.id} className={cx("px-3 py-2 text-xs font-medium text-body", numeric && "text-right")} aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : undefined}>
                    <button onClick={h.column.getToggleSortingHandler()} className={cx("inline-flex items-center gap-1 hover:text-fg", sorted && "text-fg")}>
                      <table.FlexRender header={h} />
                      {sorted === "asc" ? <CaretUp size={10} /> : sorted === "desc" ? <CaretDown size={10} /> : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody className="divide-y divide-line">
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="hover:bg-hover">
              {row.getAllCells().map((cell) => {
                const numeric = (cell.column.columnDef.meta as { numeric?: boolean } | undefined)?.numeric;
                return (
                  <td key={cell.id} className={cx("px-3 py-2", numeric && "text-right font-mono tabular-nums", cell.column.id === "when" && "text-xs text-body")}>
                    <table.FlexRender cell={cell} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
