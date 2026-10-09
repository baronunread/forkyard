import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import * as chatgpt from "../src/chatgpt";
import type { Env } from "../src/env";

/** A D1 stand-in over node:sqlite: enough of prepare/bind/first/run/all/batch for chatgpt.ts. */
function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: (string | number | null)[] = [];
    const st = {
      bind: (...a: (string | number | null)[]) => ((args = a), st),
      first: async () => (db.prepare(sql).get(...args) as unknown) ?? null,
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      all: async () => ({ results: db.prepare(sql).all(...args) }),
    };
    return st;
  };
  return { prepare, batch: async (sts: { run(): Promise<unknown> }[]) => Promise.all(sts.map((s) => s.run())) };
}

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An unsigned JWT shaped like a ChatGPT access token. */
const token = (n: number, expSeconds = 3600) =>
  `${b64url({ alg: "none" })}.${b64url({
    exp: Math.floor(Date.now() / 1000) + expSeconds,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "ada@forkyard.dev" },
    n,
  })}.sig`;

/** Fake auth.openai.com + chatgpt.com: records calls, answers the device flow, refresh and one Codex response. */
function fakeOpenAI() {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  let polls = 0;
  let issued = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const body = input instanceof Request ? await input.text() : String(init?.body ?? "");
    calls.push({ url, headers, body });
    if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "5" });
    if (url.endsWith("/deviceauth/token")) return ++polls < 2 ? new Response("", { status: 403 }) : Response.json({ authorization_code: "code_1", code_verifier: "ver_1" });
    if (url.endsWith("/oauth/token")) {
      await new Promise((r) => setTimeout(r, 50));
      return Response.json({ access_token: token(++issued), refresh_token: `refresh_${issued}`, expires_in: 3600 });
    }
    if (url.startsWith("https://chatgpt.com/backend-api/codex/responses")) {
      const text = JSON.stringify({ score: 82, summary: "Does what the task asks.", comments: [] });
      const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
      const sse = [
        ev({ type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        ev({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } }),
        ev({ type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
        ev({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: text }),
        ev({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text }),
        ev({
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
        }),
        ev({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } }),
      ].join("");
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;
  return { f, calls, refreshes: () => calls.filter((c) => c.url.endsWith("/oauth/token") && c.body.includes("refresh_token")).length };
}

let env: Env;
let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec(String(readFileSync(new URL("../migrations/0003_model_credentials.sql", import.meta.url).pathname)));
  db.exec(String(readFileSync(new URL("../migrations/0009_chatgpt_model.sql", import.meta.url).pathname)));
  db.exec(String(readFileSync(new URL("../migrations/0011_review_model.sql", import.meta.url).pathname)));
  db.exec("CREATE TABLE yard_members (yard_id TEXT, user_id TEXT, role TEXT, created_at TEXT)");
  env = { DB: d1(db), BETTER_AUTH_SECRET: "test-secret-0123456789" } as unknown as Env;
});

describe("ChatGPT sign-in for reviews", () => {
  it("signs in with the device code flow and stores the credential encrypted", async () => {
    const o = fakeOpenAI();
    const started = await chatgpt.startDeviceLogin(env, "u1", o.f);
    expect(started.pending).toMatchObject({ userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/codex/device", intervalSeconds: 5 });
    expect((await chatgpt.pollDeviceLogin(env, "u1", o.f)).state).toBe("pending");
    const done = await chatgpt.pollDeviceLogin(env, "u1", o.f);
    expect(done).toMatchObject({ state: "connected", connected: true, label: "ada@forkyard.dev (plus)", useForReviews: true, pending: null });
    const stored = db.prepare("SELECT credential FROM model_credentials").get() as { credential: string };
    expect(stored.credential).not.toContain("refresh_1");
    expect((await chatgpt.open<{ refresh: string }>(env, stored.credential)).refresh).toBe("refresh_1");
  });

  it("accepts a pasted pi auth.json or Codex CLI auth.json, and rejects other tokens", () => {
    const pi = chatgpt.parsePastedCredential(JSON.stringify({ "openai-codex": { type: "oauth", access: token(1), refresh: "r", expires: 123 } }));
    expect(pi).toMatchObject({ refresh: "r", expires: 123, accountId: "acct_123" });
    const codex = chatgpt.parsePastedCredential(JSON.stringify({ tokens: { access_token: token(2), refresh_token: "r2", account_id: "acct_123" } }));
    expect(codex.refresh).toBe("r2");
    const plain = `${b64url({})}.${b64url({ sub: "x" })}.s`;
    expect(() => chatgpt.parsePastedCredential(JSON.stringify({ tokens: { access_token: plain, refresh_token: "r" } }))).toThrow(/ChatGPT account/);
    expect(() => chatgpt.parsePastedCredential("nope")).toThrow(/Paste the JSON/);
  });

  it("refreshes an expiring token once, even when many reviews ask at the same time", async () => {
    const o = fakeOpenAI();
    await chatgpt.save(env, "u1", { type: "oauth", access: token(0, 60), refresh: "refresh_0", expires: Date.now() + 60_000, accountId: "acct_123" });
    const got = await Promise.all(Array.from({ length: 5 }, () => chatgpt.freshCredential(env, "u1", o.f)));
    expect(o.refreshes()).toBe(1);
    expect(new Set(got.map((c) => c!.refresh))).toEqual(new Set(["refresh_1"]));
  });

  it("reviews through pi-ai's Codex provider with the person's subscription", async () => {
    const access = token(7);
    const o = fakeOpenAI();
    await chatgpt.save(env, "u1", { type: "oauth", access, refresh: "refresh_7", expires: Date.now() + 3600_000, accountId: "acct_123" });
    db.prepare("INSERT INTO yard_members VALUES ('y1', 'u1', 'owner', '')").run();
    expect(await chatgpt.yardReviewer(env, "y1")).toBe("u1");
    const realFetch = globalThis.fetch;
    globalThis.fetch = o.f; // pi-ai uses the global fetch
    try {
      // The configured model is the one used, not the catalog's first.
      const picked = Object.values(OPENAI_CODEX_MODELS)[1]!.id;
      await chatgpt.setPrefs(env, "u1", { model: picked });
      const r = await chatgpt.complete(env, "u1", "You review forks.", "Review this diff.", o.f);
      expect(JSON.parse(r.text)).toMatchObject({ score: 82 });
      expect(r.model).toBe(picked);
      // A reviewer pick of its own wins over the agents' model.
      const reviewer = Object.values(OPENAI_CODEX_MODELS)[2]!.id;
      await chatgpt.setPrefs(env, "u1", { reviewModel: reviewer });
      expect((await chatgpt.complete(env, "u1", "You review forks.", "Review this diff.", o.f)).model).toBe(reviewer);
    } finally {
      globalThis.fetch = realFetch;
    }
    const call = o.calls.find((c) => c.url.startsWith("https://chatgpt.com/backend-api/codex/responses"))!;
    expect(call.headers.get("authorization")).toBe(`Bearer ${access}`);
    expect(call.headers.get("chatgpt-account-id")).toBe("acct_123");
    expect(o.refreshes()).toBe(0);
    await chatgpt.setPrefs(env, "u1", { useForReviews: false });
    expect(await chatgpt.yardReviewer(env, "y1")).toBeNull();
  });
});
