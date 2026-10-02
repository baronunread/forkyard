import { createKumoToastManager } from "@cloudflare/kumo";

export const toasts = createKumoToastManager();

export function toastError(err: unknown, title = "Something went wrong") {
  toasts.add({ title, description: err instanceof Error ? err.message : String(err), variant: "error" });
}
