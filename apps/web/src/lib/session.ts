import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";
import { authClient } from "./auth-client";
import { meQuery } from "./queries";

/** The signed-in person (Better Auth session via /api/me), or null. */
export function useMe() {
  return useQuery(meQuery).data ?? null;
}

export function useSignOut() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return useCallback(async () => {
    await authClient.signOut();
    qc.clear();
    await navigate({ to: "/login", search: {} });
  }, [qc, navigate]);
}
