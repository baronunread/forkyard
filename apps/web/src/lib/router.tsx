import { useEffect, useState } from "react";

/** A tiny history router: `/`, `/y/:yard`, `/y/:yard/t/:task`, `/bench`. */
export type Route =
  | { name: "home" }
  | { name: "yard"; yard: string }
  | { name: "task"; yard: string; task: string; agent?: string; file?: string }
  | { name: "bench" };

export function parse(pathname: string, search = ""): Route {
  const q = new URLSearchParams(search);
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "bench") return { name: "bench" };
  if (parts[0] === "y" && parts[1] && parts[2] === "t" && parts[3])
    return { name: "task", yard: parts[1], task: parts[3], agent: q.get("agent") ?? undefined, file: q.get("file") ?? undefined };
  if (parts[0] === "y" && parts[1]) return { name: "yard", yard: parts[1] };
  return { name: "home" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "home":
      return "/";
    case "bench":
      return "/bench";
    case "yard":
      return `/y/${encodeURIComponent(r.yard)}`;
    case "task": {
      const q = new URLSearchParams();
      if (r.agent) q.set("agent", r.agent);
      if (r.file) q.set("file", r.file);
      const s = q.toString();
      return `/y/${encodeURIComponent(r.yard)}/t/${encodeURIComponent(r.task)}${s ? `?${s}` : ""}`;
    }
  }
}

export function navigate(r: Route | string, replace = false): void {
  const url = typeof r === "string" ? r : href(r);
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname, location.search));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname, location.search));
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return route;
}
