import type { Context, Credential, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { now } from "./db";
import type { Env } from "./env";

/**
 * A person's own ChatGPT subscription, used for reviews in the yards they own.
 *
 * Requests go through pi-ai's `openai-codex` provider (the Pi harness's model
 * layer), so the subscription pays for reviews instead of per-token billing.
 * Sign-in is the Codex device-code flow, which is plain HTTPS and so runs in
 * the Worker: the person opens auth.openai.com/codex/device, enters a code, and
 * the browser polls until it completes. No CLI, no callback server, no sandbox.
 *
 * The credential is AES-GCM encrypted in D1. OpenAI rotates refresh tokens, so
 * refreshes are serialized through a short claim on the row: concurrent reviews
 * wait for the one refreshing instead of spending the same refresh token twice.
 */

export const CHATGPT = "openai-codex";
export const CHATGPT_REVIEW_MODEL = "gpt-5.5";

// The Codex CLI's public OAuth client and endpoints (the same ones pi-ai uses).
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const DEVICE_USER_CODE_URL = `${AUTH}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH}/oauth/token`;
const DEVICE_REDIRECT_URI = `${AUTH}/deviceauth/callback`;
export const DEVICE_VERIFICATION_URI = `${AUTH}/codex/device`;
const DEVICE_TTL_MS = 15 * 60_000;
/** Refresh this long before expiry, so a review never starts with a token about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REFRESH_CLAIM_MS = 30_000;

export type Fetch = typeof fetch;

export interface ChatGPTCredential extends OAuthCredential {
  accountId: string;
}

// ── tokens ───────────────────────────────────────────────────────────────────

function jwtClaims(token: string): Record<string, unknown> | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Account id and a display label (the ChatGPT email when the token carries it). */
export function describeToken(access: string): { accountId: string | null; label: string | null; exp: number | null } {
  const c = jwtClaims(access);
  const auth = c?.["https://api.openai.com/auth"] as { chatgpt_account_id?: string; chatgpt_plan_type?: string } | undefined;
  const profile = c?.["https://api.openai.com/profile"] as { email?: string } | undefined;
  const plan = auth?.chatgpt_plan_type ? ` (${auth.chatgpt_plan_type})` : "";
  return {
    accountId: auth?.chatgpt_account_id || null,
    label: profile?.email ? `${profile.email}${plan}` : plan.trim() || null,
    exp: typeof c?.exp === "number" ? c.exp * 1000 : null,
  };
}

function credentialFrom(access: string, refresh: string, expires: number | null): ChatGPTCredential {
  const d = describeToken(access);
  if (!d.accountId) throw new ChatGPTError("This token isn't a ChatGPT sign-in (no ChatGPT account id in it).", 400);
  return { type: "oauth", access, refresh, expires: expires ?? d.exp ?? Date.now() + 3600_000, accountId: d.accountId };
}

export class ChatGPTError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409 | 502 = 502,
  ) {
    super(message);
  }
}

async function tokenResponse(res: Response, what: string): Promise<{ access: string; refresh: string; expires: number }> {
  const text = await res.text();
  if (!res.ok) throw new ChatGPTError(`ChatGPT ${what} failed (${res.status}): ${text.slice(0, 300)}`, res.status === 400 || res.status === 401 ? 401 : 502);
  const j = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!j.access_token || !j.refresh_token || typeof j.expires_in !== "number") throw new ChatGPTError(`ChatGPT ${what} returned an incomplete token`);
  return { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + j.expires_in * 1000 };
}

/**
 * Accept what someone can paste instead of using the device flow: pi's auth.json
 * (`{"openai-codex": {type: "oauth", access, refresh, expires}}` or just that entry), or the
 * Codex CLI's ~/.codex/auth.json (`{tokens: {access_token, refresh_token}}`).
 */
export function parsePastedCredential(text: string): ChatGPTCredential {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ChatGPTError("Paste the JSON from pi's auth.json or ~/.codex/auth.json.", 400);
  }
  const entry = (j[CHATGPT] ?? j) as Record<string, unknown>;
  if (typeof entry.access === "string" && typeof entry.refresh === "string")
    return credentialFrom(entry.access, entry.refresh, typeof entry.expires === "number" ? entry.expires : null);
  const tokens = j.tokens as Record<string, unknown> | undefined;
  if (typeof tokens?.access_token === "string" && typeof tokens.refresh_token === "string") return credentialFrom(tokens.access_token, tokens.refresh_token, null);
  throw new ChatGPTError("No ChatGPT access and refresh token found in that JSON.", 400);
}

// ── encryption at rest ───────────────────────────────────────────────────────

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new ChatGPTError("BETTER_AUTH_SECRET is not set; can't store credentials.", 409);
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("forkyard/model-credentials/v1"), info: new Uint8Array() },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(env: Env, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function open<T>(env: Env, sealed: string): Promise<T> {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv ?? "") }, await key(env), unb64(ct ?? ""));
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

// ── storage ──────────────────────────────────────────────────────────────────

export interface ChatGPTStatus {
  connected: boolean;
  label: string | null;
  useForReviews: boolean;
  model: string;
  pending: { userCode: string; verificationUri: string; intervalSeconds: number; expiresAt: number } | null;
}

export async function status(env: Env, userId: string): Promise<ChatGPTStatus> {
  const [row, pending] = await Promise.all([
    env.DB.prepare("SELECT label, use_for_reviews FROM model_credentials WHERE user_id = ? AND provider_id = ?").bind(userId, CHATGPT).first<{ label: string | null; use_for_reviews: number }>(),
    env.DB.prepare("SELECT user_code, interval_s, expires_at FROM model_device_logins WHERE user_id = ? AND provider_id = ? AND expires_at > ?")
      .bind(userId, CHATGPT, Date.now())
      .first<{ user_code: string; interval_s: number; expires_at: number }>(),
  ]);
  return {
    connected: !!row,
    label: row?.label ?? null,
    useForReviews: !!row?.use_for_reviews,
    model: CHATGPT_REVIEW_MODEL,
    pending: pending ? { userCode: pending.user_code, verificationUri: DEVICE_VERIFICATION_URI, intervalSeconds: pending.interval_s, expiresAt: pending.expires_at } : null,
  };
}

export async function save(env: Env, userId: string, cred: ChatGPTCredential): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO model_credentials (user_id, provider_id, credential, label, use_for_reviews, refreshing_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, NULL, ?, ?)
     ON CONFLICT (user_id, provider_id) DO UPDATE SET credential = excluded.credential, label = excluded.label, refreshing_until = NULL, updated_at = excluded.updated_at`,
  )
    .bind(userId, CHATGPT, await seal(env, cred), describeToken(cred.access).label, ts, ts)
    .run();
}

export async function setUseForReviews(env: Env, userId: string, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE model_credentials SET use_for_reviews = ? WHERE user_id = ? AND provider_id = ?").bind(on ? 1 : 0, userId, CHATGPT).run();
}

export async function disconnect(env: Env, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM model_credentials WHERE user_id = ? AND provider_id = ?").bind(userId, CHATGPT),
    env.DB.prepare("DELETE FROM model_device_logins WHERE user_id = ? AND provider_id = ?").bind(userId, CHATGPT),
  ]);
}

// ── device-code sign-in ──────────────────────────────────────────────────────

export async function startDeviceLogin(env: Env, userId: string, f: Fetch = fetch): Promise<ChatGPTStatus> {
  const res = await f(DEVICE_USER_CODE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID }) });
  if (res.status === 404) throw new ChatGPTError("Device-code sign-in isn't enabled for this ChatGPT account. Turn it on in ChatGPT's security settings, or paste a credential instead.", 409);
  if (!res.ok) throw new ChatGPTError(`Couldn't start ChatGPT sign-in (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { device_auth_id?: string; user_code?: string; interval?: number | string };
  const interval = Number(typeof j.interval === "string" ? j.interval.trim() : j.interval);
  if (!j.device_auth_id || !j.user_code || !Number.isFinite(interval)) throw new ChatGPTError("ChatGPT returned an unexpected sign-in response");
  await env.DB.prepare(
    "INSERT OR REPLACE INTO model_device_logins (user_id, provider_id, device_auth_id, user_code, interval_s, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(userId, CHATGPT, j.device_auth_id, j.user_code, Math.max(1, interval), Date.now() + DEVICE_TTL_MS)
    .run();
  return status(env, userId);
}

/** One poll of a pending sign-in. The browser calls this every `intervalSeconds`. */
export async function pollDeviceLogin(env: Env, userId: string, f: Fetch = fetch): Promise<{ state: "pending" | "connected" | "expired" } & ChatGPTStatus> {
  const p = await env.DB.prepare("SELECT device_auth_id, user_code, expires_at FROM model_device_logins WHERE user_id = ? AND provider_id = ?")
    .bind(userId, CHATGPT)
    .first<{ device_auth_id: string; user_code: string; expires_at: number }>();
  if (!p || p.expires_at < Date.now()) return { state: "expired", ...(await status(env, userId)) };
  const res = await f(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: p.device_auth_id, user_code: p.user_code }),
  });
  if (res.status === 403 || res.status === 404) return { state: "pending", ...(await status(env, userId)) };
  const text = await res.text();
  if (!res.ok) {
    if (/authorization_pending|slow_down/.test(text)) return { state: "pending", ...(await status(env, userId)) };
    throw new ChatGPTError(`ChatGPT sign-in failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const j = JSON.parse(text) as { authorization_code?: string; code_verifier?: string };
  if (!j.authorization_code || !j.code_verifier) throw new ChatGPTError("ChatGPT returned an unexpected sign-in response");
  const tok = await tokenResponse(
    await f(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT_ID, code: j.authorization_code, code_verifier: j.code_verifier, redirect_uri: DEVICE_REDIRECT_URI }),
    }),
    "sign-in",
  );
  await save(env, userId, credentialFrom(tok.access, tok.refresh, tok.expires));
  await env.DB.prepare("DELETE FROM model_device_logins WHERE user_id = ? AND provider_id = ?").bind(userId, CHATGPT).run();
  return { state: "connected", ...(await status(env, userId)) };
}

// ── a fresh credential, refreshed by one caller at a time ───────────────────

export async function freshCredential(env: Env, userId: string, f: Fetch = fetch): Promise<ChatGPTCredential | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await env.DB.prepare("SELECT credential, refreshing_until FROM model_credentials WHERE user_id = ? AND provider_id = ?")
      .bind(userId, CHATGPT)
      .first<{ credential: string; refreshing_until: number | null }>();
    if (!row) return null;
    const cred = await open<ChatGPTCredential>(env, row.credential);
    if (cred.expires - REFRESH_MARGIN_MS > Date.now()) return cred;
    // Claim the refresh; whoever loses waits for the winner's new token.
    const t = Date.now();
    const claim = await env.DB.prepare(
      "UPDATE model_credentials SET refreshing_until = ? WHERE user_id = ? AND provider_id = ? AND (refreshing_until IS NULL OR refreshing_until < ?)",
    )
      .bind(t + REFRESH_CLAIM_MS, userId, CHATGPT, t)
      .run();
    if (!claim.meta.changes) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      const tok = await tokenResponse(
        await f(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh, client_id: CLIENT_ID }),
        }),
        "token refresh",
      );
      const next = credentialFrom(tok.access, tok.refresh, tok.expires);
      await save(env, userId, next);
      return next;
    } catch (err) {
      await env.DB.prepare("UPDATE model_credentials SET refreshing_until = NULL WHERE user_id = ? AND provider_id = ?").bind(userId, CHATGPT).run();
      throw err;
    }
  }
  throw new ChatGPTError("Timed out waiting for a ChatGPT token refresh");
}

/** The owner of a yard whose ChatGPT reviews its forks, if they connected one and left it on. */
export async function yardReviewer(env: Env, yardId: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT m.user_id FROM yard_members m JOIN model_credentials c ON c.user_id = m.user_id AND c.provider_id = ?
     WHERE m.yard_id = ? AND m.role = 'owner' AND c.use_for_reviews = 1 LIMIT 1`,
  )
    .bind(CHATGPT, yardId)
    .first<{ user_id: string }>();
  return r?.user_id ?? null;
}

/**
 * pi-ai's `openai-codex` provider, assembled from its public parts. The stock factory loads its
 * OAuth flow through an `import.meta.url`-relative dynamic import (to keep Node-only login code out
 * of bundles), which doesn't resolve in a bundled Worker. Login and refresh happen above anyway; all
 * the request path needs is `toAuth`, which for Codex is the access token as the bearer.
 */
/**
 * pi-ai's `openai-codex` provider, assembled from its public parts. The stock factory loads its
 * OAuth flow through an `import.meta.url`-relative dynamic import (to keep Node-only login code out
 * of bundles), which doesn't resolve in a bundled Worker. Login and refresh happen here (device flow,
 * freshCredential); all the request path needs is `toAuth`: the access token as the bearer.
 * Imports use pi-ai's subpaths: through the package root, esbuild leaves its classes uninitialized.
 */
export function codexProviderSync() {
  return createProvider({
    id: CHATGPT,
    name: "OpenAI Codex (ChatGPT subscription)",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: {
      oauth: {
        name: "OpenAI (ChatGPT Plus/Pro)",
        isSubscription: true,
        login: async () => {
          throw new ChatGPTError("Connect ChatGPT from Forkyard's account menu.", 409);
        },
        // freshCredential() refreshes before every request, under a D1 claim.
        refresh: async (credential) => credential,
        toAuth: async (credential) => ({ apiKey: credential.access }),
      },
    },
    models: Object.values(OPENAI_CODEX_MODELS),
    api: openAICodexResponsesApi(),
  });
}

/** A read-only credential store holding just this request's credential. */
function oneCredential(cred: ChatGPTCredential): CredentialStore {
  let current: Credential | undefined = cred;
  return {
    read: async (id) => (id === CHATGPT ? current : undefined),
    list: async () => (current ? [{ providerId: CHATGPT, type: "oauth" as const }] : []),
    modify: async (id, fn) => (id === CHATGPT ? (current = (await fn(current)) ?? current) : undefined),
    delete: async () => {
      current = undefined;
    },
  };
}

/** One completion on the person's ChatGPT subscription, through pi-ai. Returns the text. */
export async function complete(env: Env, userId: string, system: string, prompt: string, f: Fetch = fetch): Promise<{ text: string; model: string }> {
  const cred = await freshCredential(env, userId, f);
  if (!cred) throw new ChatGPTError("No ChatGPT connected", 409);
  // A per-request store holding the fresh credential: pi-ai derives request auth (bearer token,
  // ChatGPT account header) from it. Refresh already happened above, under our D1 claim.
  const credentials = oneCredential(cred);
  const models = createModels({ credentials });
  models.setProvider(codexProviderSync());
  const model = models.getModel(CHATGPT, CHATGPT_REVIEW_MODEL) ?? models.getModels(CHATGPT)[0];
  if (!model) throw new ChatGPTError("pi-ai has no ChatGPT models");
  const context: Context = { systemPrompt: system, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] };
  // SSE, not pi-ai's default WebSocket: Workers can't open an outbound WebSocket with custom headers.
  const out = await models.complete(model, context, { transport: "sse", timeoutMs: 90_000 });
  if (out.stopReason === "error") throw new ChatGPTError(`ChatGPT review failed: ${out.errorMessage ?? "unknown error"}`);
  const text = out.content.map((c) => (c.type === "text" ? c.text : "")).join("");
  return { text, model: model.id };
}
