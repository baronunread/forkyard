import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "../components/AppShell";
import { BenchPage } from "../pages/BenchPage";
import { Connect } from "../pages/Connect";
import { Login } from "../pages/Login";
import { Overview } from "../pages/Overview";
import { TaskPage } from "../pages/TaskPage";
import { oauthInFlight } from "./auth-client";
import { meQuery, queryClient } from "./queries";
import { safeNext } from "./safe-next";
import { TaskSearch } from "./search";
import { toasts } from "./toast";

/**
 * TanStack Router, code-based:
 *
 *   /login                    sign in (also the OAuth login step for agents)
 *   /connect                  an agent's OAuth: pick a seat, consent
 *   /                         overview: every yard on the left, the selected one's overview on the right
 *   /y/$yard                  the same, with that yard selected
 *   /y/$yard/t/$task          a task (?agent=&file=&view=)
 *   /bench                    benchmarks
 *
 * Everything under the `app` layout needs a signed-in person (checked in beforeLoad).
 */

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <Toasty toastManager={toasts}>
      <TooltipProvider>
        <Outlet />
      </TooltipProvider>
    </Toasty>
  ),
});


const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  // Loose: during an agent's OAuth the signed authorization request rides in the query.
  validateSearch: z.looseObject({ next: z.string().optional(), error: z.string().optional() }),
  beforeLoad: async ({ context, search }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    // Signed in already: go where you were headed (an agent's sign-in step still shows, to switch accounts).
    if (me?.user && !oauthInFlight()) throw redirect({ href: safeNext(search.next), replace: true });
  },
  component: Login,
});

const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connect",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me?.user) throw redirect({ to: "/login", search: { next: location.href } });
  },
  component: Connect,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me?.user) throw redirect({ to: "/login", search: { next: location.href } });
    return { me };
  },
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: () => <Overview yard={null} />,
});

const yardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/y/$yard",
  component: function YardOverview() {
    const { yard } = yardRoute.useParams();
    return <Overview yard={yard} />;
  },
});

const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/y/$yard/t/$task",
  validateSearch: TaskSearch,
  component: function TaskRouteView() {
    const { yard, task } = taskRoute.useParams();
    const search = taskRoute.useSearch();
    return <TaskPage key={`${yard}/${task}`} yard={yard} task={task} search={search} />;
  },
});

const benchRoute = createRoute({ getParentRoute: () => appRoute, path: "/bench", component: BenchPage });

const routeTree = rootRoute.addChildren([loginRoute, connectRoute, appRoute.addChildren([indexRoute, yardRoute, taskRoute, benchRoute])]);

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  // Loaders don't own data here; TanStack Query does.
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
