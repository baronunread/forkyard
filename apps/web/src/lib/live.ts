import type { ServerMessage, YardEvent } from "@forkyard/shared";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getKey } from "./api";
import { taskEventsQuery } from "./queries";

export type LiveState = "connecting" | "live" | "offline";

/**
 * Subscribe to a yard's live event stream. Reconnects with backoff and
 * resumes from the last seen offset, so no event is missed across drops.
 */
export function useYardLive(yardId: string | null, onEvent: (e: YardEvent) => void, onOverlap?: (m: Extract<ServerMessage, { kind: "overlap" }>) => void) {
  const [state, setState] = useState<LiveState>("connecting");
  const last = useRef<number | null>(null);
  const handler = useRef(onEvent);
  const overlapHandler = useRef(onOverlap);
  handler.current = onEvent;
  overlapHandler.current = onOverlap;

  useEffect(() => {
    if (!yardId) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let ping: ReturnType<typeof setInterval> | undefined;
    last.current = null;

    const connect = () => {
      setState("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const q = new URLSearchParams();
      if (last.current !== null) q.set("since", String(last.current));
      const k = getKey();
      if (k) q.set("key", k);
      ws = new WebSocket(`${proto}://${location.host}/api/yards/${encodeURIComponent(yardId)}/ws?${q}`);
      ws.onopen = () => {
        attempt = 0;
        setState("live");
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ kind: "ping", t: Date.now() })), 25_000);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as ServerMessage;
        if (msg.kind === "hello" && last.current === null) last.current = msg.head;
        if (msg.kind === "event") {
          if (last.current !== null && msg.event.seq <= last.current) return;
          last.current = msg.event.seq;
          handler.current(msg.event);
        }
        if (msg.kind === "overlap") overlapHandler.current?.(msg);
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        setState("offline");
        attempt++;
        setTimeout(connect, Math.min(10_000, 400 * 2 ** attempt));
      };
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      ws?.close();
    };
  }, [yardId]);

  return state;
}

/**
 * Keep TanStack Query in sync with a yard's live stream: events for a task
 * are appended to its cached event log, and bursts of events refetch the
 * yard's queries once (debounced) instead of per event.
 */
export function useYardSync(yardId: string | null, onEvent?: (e: YardEvent) => void): LiveState {
  const qc = useQueryClient();
  const refresh = useDebouncedCallback(
    (yard: string) => {
      void qc.invalidateQueries({ queryKey: ["yard", yard], predicate: (q) => q.queryKey[q.queryKey.length - 1] !== "events" });
      void qc.invalidateQueries({ queryKey: ["yards"] });
    },
    { wait: 300 },
  );
  return useYardLive(yardId, (e) => {
    if (!yardId) return;
    if (e.taskId)
      qc.setQueryData(taskEventsQuery(yardId, e.taskId).queryKey, (prev) => (prev && !prev.some((x) => x.seq === e.seq) ? [...prev, e] : prev));
    refresh(yardId);
    onEvent?.(e);
  });
}
