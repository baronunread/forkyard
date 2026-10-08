import { Dialog, InputArea, Switch } from "@cloudflare/kumo";
import { ArrowSquareOut, CheckCircle } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { call, client } from "../lib/api";
import { toastError } from "../lib/toast";
import { Button } from "./ui";

const route = client.me.models.chatgpt;
const KEY = ["me", "chatgpt"];

/**
 * Your own ChatGPT plan reviews the forks in yards you own (through pi-ai's Codex provider),
 * instead of Workers AI. Sign-in is a device code: open OpenAI's page, enter the code, done.
 */
export function ChatGPTDialog({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: KEY, queryFn: () => call(route.$get()), enabled: open });
  const set = (s: unknown) => qc.setQueryData(KEY, s);
  const [paste, setPaste] = useState(false);
  const [credential, setCredential] = useState("");

  const start = useMutation({ mutationFn: () => call(route.device.$post()), onSuccess: set, onError: (e) => toastError(e, "Couldn't start ChatGPT sign-in") });
  const toggle = useMutation({ mutationFn: (useForReviews: boolean) => call(route.$put({ json: { useForReviews } })), onSuccess: set, onError: (e) => toastError(e, "Couldn't save") });
  const disconnect = useMutation({ mutationFn: () => call(route.$delete()), onSuccess: set, onError: (e) => toastError(e, "Couldn't disconnect") });
  const pasteM = useMutation({
    mutationFn: () => call(route.paste.$post({ json: { credential } })),
    onSuccess: (s) => {
      set(s);
      setPaste(false);
      setCredential("");
    },
    onError: (e) => toastError(e, "That credential didn't work"),
  });

  // While a sign-in is pending, poll at the interval OpenAI asked for.
  const s = status.data;
  const pending = open && s && !s.connected ? s.pending : null;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      try {
        set(await call(route.device.poll.$post()));
      } catch (e) {
        toastError(e, "ChatGPT sign-in failed");
      }
    }, pending.intervalSeconds * 1000);
    return () => clearInterval(t);
  }, [pending?.userCode, pending?.intervalSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-h2">ChatGPT for reviews</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-body">
          Forks in yards you own are reviewed on your ChatGPT plan, through pi's Codex provider. Without it, reviews use Workers AI.
        </Dialog.Description>

        <div className="mt-5">
          {!s ? null : s.connected ? (
            <div className="space-y-4">
              <p className="flex items-center gap-2 text-[14px]">
                <CheckCircle weight="fill" className="text-good" size={18} />
                Connected{s.label ? <span className="text-body">as {s.label}</span> : null}
              </p>
              <Switch label={`Review my yards with ${s.model}`} checked={s.useForReviews} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} />
            </div>
          ) : s.pending ? (
            <div className="rounded-lg bg-surface-2 p-5 text-center ring-1 ring-line">
              <p className="text-sm text-body">Enter this code on OpenAI's page:</p>
              <p className="mt-2 font-mono text-[28px] font-medium tracking-[0.08em] text-fg">{s.pending.userCode}</p>
              <a href={s.pending.verificationUri} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-link hover:underline">
                Open auth.openai.com <ArrowSquareOut size={14} />
              </a>
              <p className="mt-3 text-xs text-muted">Waiting for you to approve…</p>
            </div>
          ) : paste ? (
            <InputArea
              label="Credential JSON"
              description="The contents of ~/.codex/auth.json, or pi's auth.json. Stored encrypted."
              rows={5}
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
            />
          ) : (
            <p className="text-sm text-body">You'll get a short code to enter on auth.openai.com. Nothing to install.</p>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between gap-2">
          {s && !s.connected && !s.pending ? (
            <button className="text-sm text-body hover:text-fg" onClick={() => setPaste(!paste)}>
              {paste ? "Use a code instead" : "Paste a credential instead"}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {s?.connected ? (
              <>
                <Button variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>
                  Disconnect
                </Button>
                <Button onClick={() => setOpen(false)}>Done</Button>
              </>
            ) : paste ? (
              <Button variant="primary" loading={pasteM.isPending} disabled={!credential.trim()} onClick={() => pasteM.mutate()}>
                Connect
              </Button>
            ) : s?.pending ? (
              <Button onClick={() => setOpen(false)}>Close</Button>
            ) : (
              <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>
                Connect ChatGPT
              </Button>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
