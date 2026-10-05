/**
 * A post-sign-in destination, only if it stays on this origin. Resolving against our
 * origin also catches `/\evil.com`, which browsers read as `//evil.com`.
 */
export function safeNext(n: string | null | undefined): string {
  if (!n?.startsWith("/")) return "/";
  try {
    const u = new URL(n, location.origin);
    return u.origin === location.origin ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch {
    return "/";
  }
}
