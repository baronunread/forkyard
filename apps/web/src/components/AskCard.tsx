import type { Ask } from "@forkyard/shared";
import { Robot } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { call, client } from "../lib/api";
import { ago } from "../lib/format";
import { toastError, toasts } from "../lib/toast";
import { AgentBadge, type AgentLike } from "./AgentChip";
import { Button, Card } from "./ui";
import { yardParams } from "../lib/queries";

/**
 * One thing that needs a person: an agent's question, or a decision autopilot
 * handed over. Everything needed to answer is on the card; one click does it.
 */
export function AskCard({ ask, agent, taskTitle, yardName }: { ask: Ask; agent?: AgentLike | null; taskTitle?: string | null; yardName?: string | null }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const answer = useMutation({
    mutationFn: (body: { optionId?: string; text?: string }) => call(client.yards[":yard"].asks[":ask"].answer.$post({ param: { yard: ask.yardId, ask: ask.id }, json: body })),
    onSuccess: () => {
      toasts.add({ title: decision ? "Done" : `Sent to ${who}`, variant: "success" });
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      void qc.invalidateQueries({ queryKey: ["yard", ask.yardId] });
      void qc.invalidateQueries({ queryKey: ["yards"] });
    },
    onError: (e) => toastError(e, "Could not answer"),
  });
  const decision = ask.kind === "decision";
  const who = decision ? "Autopilot" : (agent?.name ?? ask.agentId ?? "An agent");

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[13px] text-body">
        {agent && !decision ? (
          <AgentBadge agent={agent} size={20} />
        ) : (
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-ink text-on-ink">
            <Robot size={12} weight="bold" />
          </span>
        )}
        <span className="font-medium text-fg">{who}</span>
        {ask.taskId && (
          <>
            <span className="text-muted">on</span>
            <Link to="/$owner/$yard/t/$task" params={{ ...yardParams(ask.yardId), task: ask.taskId }} className="truncate hover:text-fg hover:underline">
              {taskTitle ?? ask.taskId}
            </Link>
          </>
        )}
        {yardName && <span className="truncate text-muted">· {yardName}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted">{ago(ask.createdAt)}</span>
      </div>
      <p className="mt-3 text-[15px] font-medium text-fg">{ask.question}</p>
      {ask.context && <p className="mt-1 line-clamp-3 text-sm text-body">{ask.context}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {ask.options.map((o, i) => (
          <Button
            key={o.id}
            size="sm"
            variant={decision && i === 0 ? "primary" : "secondary"}
            disabled={answer.isPending}
            onClick={() => answer.mutate({ optionId: o.id })}
          >
            {o.label}
          </Button>
        ))}
        {decision && ask.taskId && (
          <Link to="/$owner/$yard/t/$task" params={{ ...yardParams(ask.yardId), task: ask.taskId }} search={{ view: "decide" }} className="px-2 text-sm text-body hover:text-fg">
            Compare forks
          </Link>
        )}
      </div>
      {!decision && (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) answer.mutate({ text: text.trim() });
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ask.options.length ? "Or answer in your own words" : "Your answer"}
            className="h-8 min-w-0 flex-1 rounded-md bg-surface-2 px-2.5 text-[13px] text-fg ring-1 ring-line outline-none placeholder:text-muted focus:ring-link"
          />
          <Button size="sm" type="submit" disabled={!text.trim() || answer.isPending} loading={answer.isPending && !!text}>
            Send
          </Button>
        </form>
      )}
    </Card>
  );
}
