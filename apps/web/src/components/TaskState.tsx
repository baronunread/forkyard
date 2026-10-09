import { useMutation, useQueryClient } from "@tanstack/react-query";
import { call, taskRoute, type TaskDetail } from "../lib/api";
import { taskPhase, type Tone } from "../lib/phase";
import { toastError } from "../lib/toast";
import { Button, Card, Dot } from "./ui";

const TONE: Record<Tone, string> = {
  calm: "var(--color-muted)",
  busy: "var(--color-busy)",
  attention: "var(--color-overlap)",
  done: "var(--color-good)",
};

/** Where the task stands and who decides it, in one line. */
export function TaskState({ yard, detail: d }: { yard: string; detail: TaskDetail }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (on: boolean) => call(taskRoute.autopilot.$post({ param: { yard, task: d.task.id }, json: { on } })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["yard", yard] }),
    onError: (e) => toastError(e, "Could not change autopilot"),
  });
  const name = (id: string) => d.agents.find((a) => a.id === id)?.name ?? id;
  const phase = taskPhase(d.task, d.agents, d.autopilot, d.asks.length, d.decision, name);
  const open = d.task.status === "open";
  const note = !open
    ? d.decision
      ? "Now on main."
      : null
    : d.autopilot === "waiting"
      ? "Autopilot merges the best-reviewed fork once every agent has settled."
      : "You're deciding this one.";

  return (
    <Card className="flex items-center gap-3 px-5 py-3.5">
      <Dot color={TONE[phase.tone]} pulse={phase.tone === "busy"} />
      <div className="min-w-0 flex-1 text-[14px]">
        <span className="font-medium text-fg">{phase.label}</span>
        {note && <span className="text-body"> · {note}</span>}
      </div>
      {open &&
        (d.autopilot === "waiting" ? (
          <Button size="sm" variant="ghost" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>
            Turn off autopilot
          </Button>
        ) : (
          <Button size="sm" loading={toggle.isPending} onClick={() => toggle.mutate(true)}>
            Hand back to autopilot
          </Button>
        ))}
    </Card>
  );
}
