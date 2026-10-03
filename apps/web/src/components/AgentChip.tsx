import { colorByHex } from "@forkyard/shared";

export interface AgentLike {
  id: string;
  name: string;
  initials: string;
  color: string;
  harness?: string;
}

/**
 * The one way an agent is shown anywhere: a colored badge *with* initials,
 * plus the name. Color is never the only signal.
 */
export function AgentBadge({ agent, size = 20 }: { agent: AgentLike; size?: number }) {
  const c = colorByHex(agent.color);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, background: c.hex, color: c.on, fontSize: Math.max(9, size * 0.42), letterSpacing: "0.02em" }}
    >
      {agent.initials}
    </span>
  );
}

export function AgentChip({
  agent,
  size = 20,
  showName = true,
  showHarness = false,
  className = "",
}: {
  agent: AgentLike;
  size?: number;
  showName?: boolean;
  showHarness?: boolean;
  className?: string;
}) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className}`} title={`${agent.name}${agent.harness ? ` · ${agent.harness}` : ""}`}>
      <AgentBadge agent={agent} size={size} />
      {showName && <span className="truncate font-medium text-kumo-default">{agent.name}</span>}
      {showHarness && agent.harness && <span className="truncate text-xs text-kumo-subtle">{agent.harness}</span>}
      {!showName && <span className="sr-only">{agent.name}</span>}
    </span>
  );
}

/** Overlapping badges for a group of agents, capped: a thousand-agent task shows a few and "+N". */
export function AgentStack({ agents, max = 8, size = 22, title }: { agents: (AgentLike & { status?: string })[]; max?: number; size?: number; title?: string }) {
  const shown = agents.slice(0, max);
  const rest = agents.length - shown.length;
  return (
    <span className="flex items-center -space-x-1" title={title}>
      {shown.map((a) => (
        <span key={a.id} className="rounded-full ring-2 ring-surface" title={`${a.name}${a.status ? ` · ${a.status}` : ""}`}>
          <AgentBadge agent={a} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span
          className="relative inline-flex shrink-0 items-center justify-center rounded-full bg-surface-2 px-1.5 font-mono text-[11px] text-body ring-2 ring-surface"
          style={{ height: size, minWidth: size }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}
