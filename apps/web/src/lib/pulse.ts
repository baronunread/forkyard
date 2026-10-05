import type { YardEvent } from "@forkyard/shared";
import { useEffect, useState } from "react";

/**
 * A yard's heartbeat, from its live event stream: how fast agents are pushing,
 * getting reviewed and colliding right now. Kept per yard in memory and fed by
 * useYardSync, so any component can read it without its own socket.
 */

const WINDOW_MS = 120_000;
const BUCKET_MS = 5_000;
type Kind = "push" | "review" | "overlap" | "event";
const streams = new Map<string, Record<Kind, number[]>>();

export function recordPulse(yard: string, e: YardEvent): void {
  let s = streams.get(yard);
  if (!s) streams.set(yard, (s = { push: [], review: [], overlap: [], event: [] }));
  const t = Date.now();
  s.event.push(t);
  if (e.type === "push.received") s.push.push(t);
  if (e.type === "review.completed") s.review.push(t);
  if (e.type === "overlap.detected") s.overlap.push(t);
  for (const k of Object.keys(s) as Kind[]) {
    const xs = s[k];
    let drop = 0;
    while (drop < xs.length && xs[drop]! < t - WINDOW_MS) drop++;
    if (drop) xs.splice(0, drop);
  }
}

export interface Pulse {
  pushesPerMin: number;
  reviewsPerMin: number;
  overlapsPerMin: number;
  eventsPerSec: number;
  /** Pushes per 5-second bucket over the last two minutes, oldest first. */
  buckets: number[];
}

function read(yard: string): Pulse {
  const s = streams.get(yard);
  const t = Date.now();
  const n = WINDOW_MS / BUCKET_MS;
  const buckets = new Array<number>(n).fill(0);
  const lastMinute = (xs: number[]) => xs.filter((x) => x >= t - 60_000).length;
  if (!s) return { pushesPerMin: 0, reviewsPerMin: 0, overlapsPerMin: 0, eventsPerSec: 0, buckets };
  for (const x of s.push) {
    const i = n - 1 - Math.floor((t - x) / BUCKET_MS);
    if (i >= 0) buckets[i]!++;
  }
  return {
    pushesPerMin: lastMinute(s.push),
    reviewsPerMin: lastMinute(s.review),
    overlapsPerMin: lastMinute(s.overlap),
    eventsPerSec: Math.round((s.event.filter((x) => x >= t - 10_000).length / 10) * 10) / 10,
    buckets,
  };
}

/** Re-read once a second. */
export function usePulse(yard: string): Pulse {
  const [p, setP] = useState(() => read(yard));
  useEffect(() => {
    setP(read(yard));
    const t = setInterval(() => setP(read(yard)), 1000);
    return () => clearInterval(t);
  }, [yard]);
  return p;
}
