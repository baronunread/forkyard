import { concat, fromUtf8, ZERO_HASH, type GitObject } from "./objects";
import { writePack } from "./pack";
import { FLUSH, pkt, pktText, readPkts } from "./pktline";

/**
 * A tiny smart-HTTP push client. Artifacts' Workers binding is read-only for
 * content (no commit API), so Forkyard writes merge commits to the base repo
 * the same way any git client does: `git-receive-pack` over HTTPS with a
 * short-lived repo-scoped token.
 */

export class PushRejectedError extends Error {
  constructor(
    message: string,
    readonly code: "STALE" | "REJECTED" | "HTTP",
  ) {
    super(message);
    this.name = "PushRejectedError";
  }
}

export type Fetcher = (req: Request) => Promise<Response>;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "User-Agent": "git/2.47.0 (forkyard)" };
}

export async function listRemoteRefs(
  remote: string,
  token: string,
  service: "git-receive-pack" | "git-upload-pack" = "git-receive-pack",
  fetcher: Fetcher = fetch,
): Promise<Map<string, string>> {
  const res = await fetcher(
    new Request(`${remote.replace(/\/$/, "")}/info/refs?service=${service}`, { headers: authHeaders(token) }),
  );
  if (!res.ok) throw new PushRejectedError(`info/refs ${res.status}: ${await res.text()}`, "HTTP");
  return parseAdvertisement(new Uint8Array(await res.arrayBuffer()));
}

export function parseAdvertisement(body: Uint8Array): Map<string, string> {
  const refs = new Map<string, string>();
  // "# service=..." pkt, flush, then refs, flush.
  const first = readPkts(body, 0, 1);
  const startsWithService = first.items.some((i) => pktText(i)?.startsWith("# service="));
  const { items } = readPkts(body, startsWithService ? first.offset : 0, 1);
  for (const item of items) {
    const line = pktText(item);
    if (!line) continue;
    const [refPart] = line.split("\0");
    const [hash, name] = refPart!.split(" ");
    if (!hash || !name || name === "capabilities^{}") continue;
    refs.set(name, hash);
  }
  return refs;
}

export async function pushObjects(opts: {
  remote: string;
  token: string;
  ref: string;
  newHash: string;
  objects: GitObject[];
  /** Fail instead of overwriting if the ref moved since this hash. */
  expectedOld?: string | null;
  fetcher?: Fetcher;
}): Promise<{ old: string }> {
  const fetcher = opts.fetcher ?? fetch;
  const refs = await listRemoteRefs(opts.remote, opts.token, "git-receive-pack", fetcher);
  const old = refs.get(opts.ref) ?? ZERO_HASH;
  if (opts.expectedOld !== undefined && (opts.expectedOld ?? ZERO_HASH) !== old) {
    throw new PushRejectedError(`${opts.ref} moved to ${old.slice(0, 7)} (expected ${opts.expectedOld?.slice(0, 7)})`, "STALE");
  }
  const body = concat([
    pkt(`${old} ${opts.newHash} ${opts.ref}\0report-status agent=forkyard\n`),
    FLUSH,
    writePack(opts.objects),
  ]);
  const res = await fetcher(
    new Request(`${opts.remote.replace(/\/$/, "")}/git-receive-pack`, {
      method: "POST",
      headers: {
        ...authHeaders(opts.token),
        "Content-Type": "application/x-git-receive-pack-request",
        Accept: "application/x-git-receive-pack-result",
      },
      body,
    }),
  );
  if (!res.ok) throw new PushRejectedError(`receive-pack ${res.status}: ${await res.text()}`, "HTTP");
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  if (!report.unpackOk) throw new PushRejectedError(`unpack failed: ${report.lines.join("; ")}`, "REJECTED");
  const ng = report.lines.find((l) => l.startsWith("ng "));
  if (ng) throw new PushRejectedError(ng, ng.includes("fetch first") || ng.includes("stale") ? "STALE" : "REJECTED");
  return { old };
}

function parseReport(body: Uint8Array): { unpackOk: boolean; lines: string[] } {
  const { items } = readPkts(body, 0, 1);
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind !== "data") continue;
    // Tolerate side-band framing if a server sends it anyway.
    const band = item.data[0];
    const text = band === 1 ? readReportFromBand(item.data.subarray(1)) : [fromUtf8(item.data).replace(/\n$/, "")];
    lines.push(...text);
  }
  return { unpackOk: lines.some((l) => l === "unpack ok"), lines };
}

function readReportFromBand(data: Uint8Array): string[] {
  const { items } = readPkts(data, 0, 1);
  return items.map(pktText).filter((x): x is string => !!x);
}
