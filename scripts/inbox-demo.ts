/**
 * Inbox demo: agents that run on their own, and the two moments they need a person.
 *
 *   pnpm demo:inbox                 # yard "billing"
 *   pnpm demo:inbox --yard=my-yard
 *
 * Three tasks in one yard:
 *  1. "Add usage-based pricing": three agents push clean forks; autopilot merges the best.
 *  2. "Charge in the customer's currency": an agent is blocked on a product call and
 *     asks a person (ask_human) while it keeps working.
 *  3. "Retry failed webhooks": both forks leave conflict markers behind, nothing
 *     clears the review bar, and autopilot hands the decision over.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, arg, BASE, Git, Mcp, sleep } from "./lib";

const yardId = arg("yard", "billing")!;
const work = join(tmpdir(), `forkyard-inbox-${yardId}`);

const BASE_FILES: Record<string, string> = {
  "README.md": "# Billing service\n\nInvoices, plans and webhooks.\n",
  "src/plans.ts": "export const PLANS = { free: 0, pro: 20, team: 50 };\n",
  "src/invoice.ts": "export function total(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n",
  "src/webhooks.ts": "export async function deliver(url: string, body: unknown) {\n  await fetch(url, { method: \"POST\", body: JSON.stringify(body) });\n}\n",
};

type Created = { task: { id: string }; agents: { id: string; name: string }[]; credentials: { agentId: string; apiKey: string }[] };

async function task(title: string, brief: string, names: string[]): Promise<Created> {
  return api<Created>(`/yards/${yardId}/tasks`, { body: { title, brief, agents: names.map((name) => ({ name, harness: "claude-code" })) } });
}

/** One agent: claim, record intent, push one commit. */
async function agentWork(t: Created, i: number, paths: string[], intent: string, files: Record<string, string>, message: string) {
  const a = t.agents[i]!;
  const key = t.credentials.find((c) => c.agentId === a.id)!.apiKey;
  const mcp = new Mcp(key);
  const ws = await mcp.call<{ git: { remote: string; token: string } }>("workspace_get");
  const git = await Git.clone(ws.data.git.remote, join(work, t.task.id, a.id), ws.data.git.token, { name: a.name, email: `${a.id}@agents.forkyard.dev` });
  await mcp.call("claim_paths", { paths });
  await mcp.call("intent_record", { summary: intent, why: `${intent}, as the task asks.` });
  for (const [p, c] of Object.entries(files)) await git.write(p, c);
  await git.commitAndPush(message);
  return mcp;
}

async function main() {
  console.log(`Forkyard inbox demo → ${BASE}  (yard "${yardId}")\n`);
  await rm(work, { recursive: true, force: true });
  await api("/yards", { body: { id: yardId, name: "Billing service", files: BASE_FILES } }).catch((e) => {
    if (!String(e).includes("409")) throw e;
  });

  // 1. Runs itself.
  const pricing = await task("Add usage-based pricing", "Charge per API call above the plan's included volume.", ["Ada", "Bash", "Cyd"]);
  await Promise.all(
    ["Ada", "Bash", "Cyd"].map((_, i) =>
      agentWork(
        pricing,
        i,
        ["src/plans.ts", "test/plans.test.ts"],
        "Add per-call overage pricing",
        {
          "src/plans.ts": `export const PLANS = { free: 0, pro: 20, team: 50 };\n\nexport const OVERAGE_PER_1K = ${[0.4, 0.5, 0.45][i]};\n\nexport function overage(calls: number, included: number): number {\n  return Math.max(0, calls - included) / 1000 * OVERAGE_PER_1K;\n}\n`,
          "test/plans.test.ts": `import { overage } from "../src/plans";\n// ${["Ada", "Bash", "Cyd"][i]}: overage is zero within the plan\nconsole.assert(overage(100, 1000) === 0);\n`,
        },
        "feat: usage-based overage pricing",
      ),
    ),
  );
  console.log(`✓ "Add usage-based pricing": 3 forks pushed; autopilot takes it from here`);

  // 2. Blocked on a product call.
  const fx = await task("Charge in the customer's currency", "Invoices in EUR, GBP and USD.", ["Dex", "Eli"]);
  const dex = await agentWork(fx, 0, ["src/invoice.ts"], "Format invoice totals per currency", {
    "src/invoice.ts": "export function total(lines: number[], currency = \"USD\"): string {\n  const sum = lines.reduce((a, b) => a + b, 0);\n  return new Intl.NumberFormat(\"en\", { style: \"currency\", currency }).format(sum);\n}\n",
  }, "feat: currency-aware totals");
  await dex.call("ask_human", {
    question: "Which exchange rate should invoices use?",
    context: "Customers are billed monthly. Rates move during the month, so the invoice total depends on when we convert. I've done the formatting; the conversion is waiting on this.",
    options: ["Rate on the invoice date", "Monthly average rate", "Lock the rate at signup"],
  });
  console.log(`✓ "Charge in the customer's currency": Dex asked a person which exchange rate to use`);

  // 3. Nothing good enough: autopilot hands over.
  const hooks = await task("Retry failed webhooks", "Retry with backoff; give up after a day.", ["Fay", "Gus"]);
  await Promise.all(
    [0, 1].map((i) =>
      agentWork(hooks, i, ["src/webhooks.ts"], "Retry deliveries with exponential backoff", {
        "src/webhooks.ts": `export async function deliver(url: string, body: unknown, attempt = 0) {\n<<<<<<< HEAD\n  const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });\n=======\n  const res = await fetch(url, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(${i ? 5000 : 10000}) });\n>>>>>>> retry\n  console.log("delivered", res.status);\n  if (!res.ok && attempt < 8) setTimeout(() => deliver(url, body, attempt + 1), 2 ** attempt * 1000);\n}\n`,
      }, "feat: webhook retries"),
    ),
  );
  console.log(`✓ "Retry failed webhooks": both forks left conflict markers; autopilot will hand it over`);

  console.log("\nWaiting for reviews and autopilot…");
  for (let i = 0; i < 120; i++) {
    const s = await api<{ autopilot: Record<string, string> }>(`/yards/${yardId}`);
    if (s.autopilot[pricing.task.id] === "merged" && s.autopilot[hooks.task.id] === "handed") break;
    await sleep(1000);
  }
  const s = await api<{ autopilot: Record<string, string>; asks: { question: string }[] }>(`/yards/${yardId}`);
  console.log(`  pricing: ${s.autopilot[pricing.task.id]}, webhooks: ${s.autopilot[hooks.task.id]}`);
  for (const a of s.asks) console.log(`  needs you: ${a.question}`);
  console.log(`\nOpen ${BASE}/y/${yardId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
