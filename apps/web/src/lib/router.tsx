import { Toasty, TooltipProvider } from "@cloudflare/kumo";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { AppShell } from "../components/AppShell";
import { BenchPage } from "../pages/BenchPage";
import { Connect } from "../pages/Connect";
import { Login } from "../pages/Login";
import { Overview } from "../pages/Overview";
import { SettingsPage } from "../pages/SettingsPage";
import { TaskPage } from "../pages/TaskPage";
import { oauthInFlight } from "./auth-client";
import { meQuery, queryClient, yardsQuery } from "./queries";
import { safeNext } from "./safe-next";
import { TaskSearch } from "./search";
import { toasts } from "./toast";

/**
 * TanStack Router, code-based:
 *
 *   /login                    sign in (also the OAuth login step for agents)
 *   /connect                  an agent's OAuth: pick a seat, consent
 *   /                         overview: every yard on the left, the selected one's overview on the right
 *   /$owner/$yard             the same, with that yard selected
 *   /$owner/$yard/t/$task     a task (?agent=&file=&view=)
 *   /y/<yard id>/…            redirects to the yard's /owner/slug
 *   /bench                    benchmarks
 *   /settings                 your account and the deployment's limits
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

/** The yard id behind /owner/slug; /y/<id> redirects to the yard's /owner/slug. Unknown: the slug, which then 404s. */
async function resolveYard(params: { owner: string; yard: string }) {
  const yards = await queryClient.ensureQueryData(yardsQuery);
  const y = params.owner === "y" ? yards.find((y) => y.id === params.yard) : yards.find((y) => y.owner === params.owner && y.slug === params.yard);
  return { y, yardId: y?.id ?? params.yard, moved: !!y && params.owner === "y" };
}

const yardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/$owner/$yard",
  beforeLoad: async ({ params }) => {
    const { y, yardId, moved } = await resolveYard(params);
    if (moved) throw redirect({ to: "/$owner/$yard", params: { owner: y!.owner, yard: y!.slug }, replace: true });
    return { yardId };
  },
  component: function YardOverview() {
    const { yardId } = yardRoute.useRouteContext();
    return <Overview yard={yardId} />;
  },
});

const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/$owner/$yard/t/$task",
  validateSearch: TaskSearch,
  beforeLoad: async ({ params, search }) => {
    const { y, yardId, moved } = await resolveYard(params);
    if (moved) throw redirect({ to: "/$owner/$yard/t/$task", params: { owner: y!.owner, yard: y!.slug, task: params.task }, search, replace: true });
    return { yardId };
  },
  component: function TaskRouteView() {
    const { task } = taskRoute.useParams();
    const { yardId } = taskRoute.useRouteContext();
    const search = taskRoute.useSearch();
    return <TaskPage key={`${yardId}/${task}`} yard={yardId} task={task} search={search} />;
  },
});

const benchRoute = createRoute({ getParentRoute: () => appRoute, path: "/bench", component: BenchPage });

const settingsRoute = createRoute({ getParentRoute: () => appRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([loginRoute, connectRoute, appRoute.addChildren([indexRoute, yardRoute, taskRoute, benchRoute, settingsRoute])]);

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
