import type { BenchStats } from "./schemas";

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarize(samples: number[]): BenchStats {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    n,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    min: round(s[0] ?? 0),
    max: round(s[n - 1] ?? 0),
    mean: round(n ? s.reduce((a, b) => a + b, 0) / n : 0),
  };
}
