/**
 * End-to-end check against a running Forkyard (local or deployed).
 *
 *   pnpm e2e                 # runs the seed (fast) and asserts the whole story
 *   pnpm e2e --cleanup       # also triggers the cron (wrangler dev --test-scheduled, FORK_TTL_HOURS=0)
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MCP_TOOLS } from "../packages/shared/src/agents-md";
import { BASE, Git, Mcp, api, arg } from "./lib";

const run = promisify(execFile);
const yardId = `e2e-${Date.now().toString(36).slice(-5)}`;
let failures = 0;

function check(cond: unknown, label: string) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

async function expectStatus(p: Promise<unknown>, status: number, label: string) {
  try {
    await p;
    check(false, `${label} (expected ${status}, got success)`);
  } catch (e) {
    check(String(e).includes(`→ ${status}`), `${label} → ${status}`);
  }
}

type Ev = { type: string; agentId: string | null; data: Record<string, unknown> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type TaskDetail = {
  task: { status: string };
  agents: { id: string; status: string }[];
  decision: { decidedBy: string; winnerAgentId: string | null } | null;
  autopilot: string;
  asks: { id: string; kind: string; status: string; options: { id: string; label: string }[] }[];
};

/** Agents work alone; a person is only asked when an agent is blocked or no fork is good enough. */
async function autopilotChecks() {
  const t = await api<{ task: { id: string }; credentials: { agentId: string; apiKey: string }[] }>(`/yards/${yardId}/tasks`, {
    body: { title: "Autopilot probe", agents: [{ name: "Ann", harness: "test" }, { name: "Bo", harness: "test" }] },
  });
  const path = `/yards/${yardId}/tasks/${t.task.id}`;
  const [ann, bo] = t.credentials.map((c) => c.apiKey) as [string, string];
  const asked = await new Mcp(ann).call<{ id: string; options: { id: string }[] }>("ask_human", {
    question: "Which store should sessions use?",
    options: ["KV", "D1"],
  });
  const inbox = await api<{ asks: { id: string; agentName: string | null }[] }>("/inbox");
  check(inbox.asks.some((a) => a.id === asked.data.id && a.agentName === "Ann"), "a blocked agent's question lands in the inbox");

  for (const [key, name] of [[ann, "Ann"], [bo, "Bo"]] as const) {
    const ws = await new Mcp(key).call<{ git: { remote: string; token: string } }>("workspace_get");
    const g = await Git.clone(ws.data.git.remote, `${process.env.TMPDIR ?? "/tmp"}/fy-e2e-${yardId}-${name}`, ws.data.git.token, { name, email: `${name}@e` });
    await g.write(`notes/${name.toLowerCase()}.md`, `# ${name}\n\nSessions live in D1.\n`);
    await g.commitAndPush(`docs: ${name}'s notes`);
  }
  let d = await api<TaskDetail>(path);
  for (let i = 0; i < 60 && !d.agents.every((a) => a.status === "reviewed"); i++) {
    await sleep(500);
    d = await api<TaskDetail>(path);
  }
  check(d.agents.every((a) => a.status === "reviewed"), "both forks pushed and reviewed");
  await sleep(5000);
  d = await api<TaskDetail>(path);
  check(d.task.status === "open" && d.autopilot === "waiting", "autopilot holds while an agent waits on a person");

  await api(`/yards/${yardId}/asks/${asked.data.id}/answer`, { body: { optionId: asked.data.options[1]!.id } });
  const status = await new Mcp(ann).call<{ status: string; answer: string }>("ask_status", { askId: asked.data.id });
  check(status.data.status === "answered" && status.data.answer === "D1", "the agent reads the answer with ask_status");

  for (let i = 0; i < 40 && d.task.status === "open" && d.autopilot === "waiting"; i++) {
    await sleep(500);
    d = await api<TaskDetail>(path);
  }
  if (d.autopilot === "handed") {
    // Below the bar: autopilot hands the decision over with one-click options.
    const ask = d.asks.find((a) => a.kind === "decision" && a.status === "open");
    check(!!ask?.options.some((o) => o.id.startsWith("merge:")), "below the bar, autopilot asks a person with merge options");
    await api(`/yards/${yardId}/asks/${ask!.id}/answer`, { body: { optionId: ask!.options[0]!.id } });
    d = await api<TaskDetail>(path);
    check(d.task.status === "decided", "answering the decision ask merges that fork");
  } else check(d.task.status === "decided" && d.decision?.decidedBy === "autopilot", "autopilot merged the best fork once the agents settled");
}

type Browser = (path: string, init?: { method?: string; json?: unknown }) => Promise<Response>;

/**
 * A person connects their own ChatGPT for reviews in the yards they own. OpenAI isn't reachable
 * with a made-up token, so this checks the plumbing and that reviews fall back instead of stalling.
 */
async function chatgptChecks(browser: Browser) {
  const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const fake = `${b64url({ alg: "none" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "acct_e2e" }, "https://api.openai.com/profile": { email: "ada@forkyard.dev" } })}.sig`;
  const before = (await (await browser("/api/me/models/chatgpt")).json()) as { connected: boolean };
  check(!before.connected, "ChatGPT starts disconnected");
  const pasted = (await (await browser("/api/me/models/chatgpt/paste", { json: { credential: JSON.stringify({ tokens: { access_token: fake, refresh_token: "r_e2e" } }) } })).json()) as {
    connected: boolean;
    label: string | null;
    useForReviews: boolean;
  };
  check(pasted.connected && pasted.useForReviews && pasted.label === "ada@forkyard.dev", "a pasted Codex credential connects ChatGPT for reviews");

  // A yard Ada owns: its reviews would use her ChatGPT; with a token OpenAI rejects, they fall back.
  const y = `${yardId}-gpt`;
  await browser("/api/yards", { json: { id: y, name: "ChatGPT reviews", files: { "README.md": "# hi\n" } } });
  const t = (await (await browser(`/api/yards/${y}/tasks`, { json: { title: "Say hello", autopilot: false, agents: [{ name: "Kai", harness: "test" }] } })).json()) as {
    task: { id: string };
    credentials: { apiKey: string }[];
  };
  const ws = await new Mcp(t.credentials[0]!.apiKey).call<{ git: { remote: string; token: string } }>("workspace_get");
  const g = await Git.clone(ws.data.git.remote, `${process.env.TMPDIR ?? "/tmp"}/fy-e2e-${y}`, ws.data.git.token, { name: "Kai", email: "kai@e" });
  await g.write("hello.md", "hello\n");
  await g.commitAndPush("docs: hello");
  let review: { reviewer: string } | null = null;
  for (let i = 0; i < 60 && !review; i++) {
    const d = (await (await browser(`/api/yards/${y}/tasks/${t.task.id}`)).json()) as { agents: { review: { reviewer: string } | null }[] };
    review = d.agents[0]?.review ?? null;
    if (!review) await sleep(1000);
  }
  check(!!review && !review.reviewer.startsWith("chatgpt:"), `a review still lands when ChatGPT rejects the token (${review?.reviewer ?? "none"})`);

  const off = (await (await browser("/api/me/models/chatgpt", { method: "PUT", json: { useForReviews: false } })).json()) as { useForReviews: boolean };
  const gone = (await (await browser("/api/me/models/chatgpt", { method: "DELETE" })).json()) as { connected: boolean };
  check(!off.useForReviews && !gone.connected, "ChatGPT reviews can be turned off and disconnected");
}

/** Cloud agents (Pi Durable in a Durable Object) work next to local MCP seats on the same task. */
async function cloudAgentChecks() {
  const t = await api<{ task: { id: string }; agents: { id: string; harness: string }[] }>(`/yards/${yardId}/tasks`, {
    body: { title: "Cloud and local", autopilot: false, agents: [{ name: "Nimbus", runner: "cloud" }, { name: "Laptop", harness: "claude-code" }] },
  });
  check(t.agents.find((a) => a.id === "nimbus")?.harness === "pi" && t.agents.find((a) => a.id === "laptop")?.harness === "claude-code", "a task mixes a cloud agent and a local MCP seat");
  const path = `/yards/${yardId}/tasks/${t.task.id}`;
  let nimbus: { status: string; headCommit: string | null; intent: { summary: string } | null } | undefined;
  for (let i = 0; i < 60; i++) {
    const d = await api<{ agents: { id: string; status: string; headCommit: string | null; intent: { summary: string } | null }[] }>(path);
    nimbus = d.agents.find((a) => a.id === "nimbus");
    if (nimbus?.status === "reviewed") break;
    await sleep(1000);
  }
  check(!!nimbus?.headCommit && !!nimbus.intent && nimbus.status === "reviewed", "the cloud agent claimed, recorded intent, pushed, and was reviewed");
  const log = await api<{ cloud: boolean; entries: { kind: string; text: string }[] }>(`${path}/agents/nimbus/transcript`);
  check(log.cloud && log.entries.some((e) => e.text.includes("push(")), `its Pi transcript is readable (${log.entries.length} entries)`);
  await api(`${path}/abandon`, { body: { reason: "e2e done" } });
}

async function main() {
  console.log(`e2e → ${BASE}\n`);
  const seed = await run("npx", ["tsx", "scripts/seed.ts", "--pace=fast", `--yard=${yardId}`], { env: process.env, maxBuffer: 8 << 20 });
  check(seed.stdout.includes("decided: assembled"), "seed ran to a decision");

  const detail = await api<{
    task: { id: string; status: string };
    agents: { id: string; name: string; status: string; headCommit: string | null; review: { score: number } | null; intent: { summary: string } | null }[];
    decision: { mode: string; resultCommit: string } | null;
  }>(`/yards/${yardId}/tasks/validate-todo-titles`);
  check(detail.agents.length >= 3, `${detail.agents.length} agents on one task`);
  check(detail.agents.every((a) => a.headCommit), "every agent pushed");
  check(detail.agents.every((a) => a.review), "every agent was reviewed");
  check(detail.agents.every((a) => a.intent), "every agent recorded an intent");
  check(detail.task.status === "decided" && detail.decision?.mode === "assemble", "task decided by assembling hunks");

  // Event delivery is asynchronous and unordered; give stragglers a moment.
  let events: Ev[] = [];
  for (let i = 0; i < 20; i++) {
    events = (await api<{ events: Ev[] }>(`/yards/${yardId}/events?since=0&limit=1000`)).events;
    if (events.filter((e) => e.type === "push.received").length >= 9) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const types = events.map((e) => e.type);
  check(types.filter((t) => t === "agent.ready").length === detail.agents.length, "all forks became ready");
  check(types.includes("overlap.detected"), "an overlap warning was raised");
  check(events.some((e) => e.type === "overlap.detected" && (e.data.overlap as { kind: string }).kind === "change"), "a change-level overlap was detected");
  check(types.filter((t) => t === "push.received").length >= 9, "all pushes reached the yard");
  check(events.some((e) => e.type === "intent.recorded" && (e.data.intent as { source: string }).source === "git"), "intent picked up from .forkyard/intent.md");
  check(types.includes("decision.made"), "decision event emitted");

  const base = await api<{ commits: { hash: string; message: string }[] }>(`/yards/${yardId}/base`);
  check(base.commits[0]?.hash === detail.decision?.resultCommit, "base branch moved to the decision commit");
  check(base.commits[0]?.message.includes("Co-authored-by: Ada"), "merge commit credits the agents");

  // MCP parity and permissions, with a fresh task.
  const t2 = await api<{ task: { id: string }; agents: { id: string }[]; credentials: { agentId: string; apiKey: string }[] }>(`/yards/${yardId}/tasks`, {
    body: { title: "Permissions probe", agents: [{ name: "Eve", harness: "test" }, { name: "Judy", harness: "test", role: "judge" }] },
  });
  const eve = t2.credentials[0]!.apiKey;
  const judy = t2.credentials[1]!.apiKey;
  const mcp = new Mcp(eve);
  const list = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Authorization: `Bearer ${eve}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  }).then((r) => r.text());
  check(MCP_TOOLS.every(([name]) => list.includes(`"${name}"`)), `MCP exposes all ${MCP_TOOLS.length} tools`);
  const ws = await mcp.call<{ git: { remote: string; token: string }; agent: { id: string } }>("workspace_get");
  check(ws.data.agent.id === "eve", "workspace_get infers the agent from its key");
  await expectStatus(api(`/yards/${yardId}/tasks/validate-todo-titles`, { key: eve }), 403, "agent key cannot read another task");
  await expectStatus(api(`/yards/${yardId}/tasks/${t2.task.id}/decide`, { key: eve, body: { mode: "winner", winnerAgentId: "eve" } }), 403, "plain agent cannot decide");
  await expectStatus(api(`/yards/${yardId}/tasks`, { key: eve, body: { title: "x", agents: [{ name: "x" }] } }), 403, "agent cannot create tasks");
  await expectStatus(api(`/yards/${yardId}/tasks/${t2.task.id}/agents/judy/intents`, { key: eve, body: { summary: "x", why: "y" } }), 403, "agent cannot act as another agent");
  const judge = await api<{ conflicts: unknown[] }>(`/yards/${yardId}/tasks/${t2.task.id}/decide/preview`, {
    key: judy,
    body: { mode: "winner", winnerAgentId: "eve" },
  }).catch((e) => String(e));
  check(String(judge).includes("has not pushed"), "judge can preview decisions (and gets a clear error with nothing pushed)");

  // The fork token must not grant access to the base repo.
  const baseRemote = ws.data.git.remote.replace(/[^/]+\.git$/, `${yardId}--base.git`);
  const probe = await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${ws.data.git.token}`, "ls-remote", baseRemote]).then(
    () => "ok",
    (e) => String(e),
  );
  check(probe !== "ok", "fork token is rejected by the base repo");

  // A push via plain git still works with only the token.
  const g = await Git.clone(ws.data.git.remote, `${process.env.TMPDIR ?? "/tmp"}/fy-e2e-${yardId}`, ws.data.git.token, { name: "Eve", email: "e@e" });
  await g.write("NOTES.md", "plain git works\n");
  const sha = await g.commitAndPush("notes");
  check(/^[0-9a-f]{40}$/.test(sha), "plain git push with the scoped token");

  await oauthChecks(t2.task.id);

  await autopilotChecks();
  await cloudAgentChecks();

  await api(`/yards/${yardId}/tasks/${t2.task.id}/abandon`, { body: { reason: "e2e done" } });

  if (arg("cleanup") === "true") {
    // wrangler dev --test-scheduled: invoke the scheduled handler (fork cleanup cron).
    const res = await fetch(`${BASE}/cdn-cgi/local/explorer/api/local/scheduled?worker=forkyard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cron: "17 * * * *" }),
    });
    check(res.ok, "cron trigger ran");
    const after = await api<{ events: Ev[] }>(`/yards/${yardId}/events?since=0&limit=1000&types=fork.deleted`);
    check(after.events.length >= detail.agents.length, `cleanup deleted ${after.events.length} forks of closed tasks`);
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

/**
 * Sign-in and MCP OAuth as real clients do them, against emulate.dev: a person
 * signs in with (emulated) GitHub; an agent registers, gets sent through
 * /connect where the person picks a seat, and trades the code for a token.
 */
async function oauthChecks(probeTask: string) {
  const providers = (await (await fetch(`${BASE}/api/providers`)).json()) as { providers: string[]; emulated: boolean };
  if (!providers.emulated || !providers.providers.includes("github")) {
    console.log("- skipping sign-in and OAuth checks (needs emulate: pnpm emulate)");
    return;
  }
  const challenge = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(challenge.status === 401 && (challenge.headers.get("WWW-Authenticate") ?? "").includes("resource_metadata="), "unauthenticated /mcp answers 401 with resource metadata");

  // A browser: cookie jar + Origin. Node's fetch sends Sec-Fetch-Mode: cors, so Better Auth
  // answers redirects as JSON {url} (like it does for the SPA's fetch calls).
  const jar = new Map<string, string>();
  const keep = (res: Response) => {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      jar.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
    return res;
  };
  const browser = (path: string, init: { method?: string; json?: unknown } = {}) =>
    fetch(path.startsWith("http") ? path : `${BASE}${path}`, {
      method: init.method ?? (init.json ? "POST" : "GET"),
      redirect: "manual",
      headers: {
        Cookie: [...jar].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; "),
        Origin: BASE,
        ...(init.json ? { "Content-Type": "application/json" } : {}),
      },
      body: init.json ? JSON.stringify(init.json) : undefined,
    }).then(keep);
  const target = async (res: Response) => res.headers.get("Location") ?? ((await res.json()) as { url?: string; redirect_uri?: string }).url ?? "";

  // 1. A person signs in with GitHub (emulated): pick "ada" on the emulator's page.
  const start = (await (await browser("/api/auth/sign-in/social", { json: { provider: "github", callbackURL: "/" } })).json()) as { url: string };
  const gh = new URL(start.url);
  check(gh.origin !== "https://github.com", `sign-in goes to the GitHub emulator (${gh.origin})`);
  const picked = await fetch(`${gh.origin}/login/oauth/callback`, {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ login: "ada", redirect_uri: gh.searchParams.get("redirect_uri")!, scope: gh.searchParams.get("scope") ?? "", state: gh.searchParams.get("state")!, client_id: gh.searchParams.get("client_id")! }),
  });
  await browser(picked.headers.get("Location")!);
  const me = (await (await browser("/api/me")).json()) as { user: { name: string; email: string } | null };
  check(me.user?.email === "ada@forkyard.dev", `signed in with GitHub as ${me.user?.name ?? "nobody"} (Better Auth session)`);
  // The seeded yard has no owner, and in dev mode such yards are visible to every signed-in person.

  await chatgptChecks(browser);

  // 2. An agent registers itself (dynamic client registration, loopback redirect).
  const asMeta = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as {
    registration_endpoint: string;
    token_endpoint: string;
    authorization_endpoint: string;
  };
  const redirect = "http://127.0.0.1:9/callback";
  const reg = (await (
    await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "e2e agent", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
    })
  ).json()) as { client_id: string };
  check(!!reg.client_id, "dynamic client registration (loopback redirect)");

  // 3. Authorize → /connect (pick a seat) → consent → code → token.
  const token = async (seat: string) => {
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const challengeB64 = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const auth = new URL(asMeta.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "mcp offline_access", state: "s1", code_challenge: challengeB64, code_challenge_method: "S256", resource: `${BASE}/mcp` }))
      auth.searchParams.set(k, v);
    const connect = new URL(await target(await browser(auth.href)), BASE);
    if (connect.pathname !== "/connect") throw new Error(`expected /connect, got ${connect.href}`);
    await browser("/api/connect/seat", { json: { clientId: reg.client_id, seat } });
    let next = new URL(await target(await browser("/api/auth/oauth2/continue", { json: { postLogin: true, oauth_query: connect.search.slice(1) } })), BASE);
    if (next.pathname === "/connect") next = new URL(await target(await browser("/api/auth/oauth2/consent", { json: { accept: true, oauth_query: next.search.slice(1) } })), BASE);
    const code = next.searchParams.get("code");
    if (!code) throw new Error(`no code: ${next.href}`);
    const tok = (await (
      await fetch(asMeta.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
      })
    ).json()) as { access_token: string };
    return tok.access_token;
  };

  const asMe = new Mcp(await token("me"));
  const yards = await asMe.call<{ yards: { id: string }[] }>("yard_list");
  check(yards.data.yards.some((y) => y.id === yardId), "OAuth token acting as the person lists their yards");
  const seatTok = await token(`${yardId}/${probeTask}/eve`);
  const ws = await new Mcp(seatTok).call<{ agent: { id: string } }>("workspace_get");
  check(ws.data.agent.id === "eve", "OAuth token bound to an agent seat gets that seat's workspace");
  const denied = await new Mcp(seatTok).call("task_create", { yardId, title: "x", agents: [{ name: "x" }] }).then(() => "ok", (e) => String(e));
  check(denied.includes("403"), "an agent-seat token cannot create tasks");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
