"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { cancelChatGPTConnect, disconnectChatGPT, pollChatGPTConnect, startChatGPTConnect } from "@/app/(chat)/settings/connections-actions";
import { Button } from "@/components/ui/button";

type Window = { usedPercent: number | null; windowMinutes: number | null; resetAt: number | null };

export type ChatGPTConnectionView = {
  allowed: boolean;
  /** A sign-in already in progress (e.g. started before switching tabs or reloading): polling resumes. */
  pending: Flow | null;
  connection: {
    email: string | null;
    plan: string;
    accountId: string;
    status: "active" | "needs_reauth";
    connectedAt: string;
    lastRefreshAt: string | null;
    rateLimits: { primary?: Window; secondary?: Window } | null;
  } | null;
};

type Flow = { userCode: string; verificationUrl: string; intervalSec: number; expiresAt: string };

/** Consecutive failed poll requests (network, redeploy) before giving up. */
const MAX_POLL_FAILURES = 3;

function windowLabel(minutes: number | null) {
  if (!minutes) return "Usage";
  if (minutes % 10080 === 0) return `${minutes / 10080}-week limit`;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

function UsageBar({ w }: { w: Window }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted">
        <span>{windowLabel(w.windowMinutes)}</span>
        <span>
          {Math.round(pct)}% used{w.resetAt ? ` · resets ${new Date(w.resetAt * 1000).toLocaleString()}` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-hover">
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Settings → Connected accounts: connect a ChatGPT plan with a device code, see its status, disconnect. */
export function ChatGPTConnection({ view }: { view: ChatGPTConnectionView }) {
  const router = useRouter();
  const [flow, setFlow] = useState<Flow | null>(view.pending);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const c = view.connection;

  useEffect(() => {
    if (!flow) return;
    let stopped = false;
    let failures = 0;
    const expiresAt = Date.parse(flow.expiresAt);
    const stop = (message: string | null) => {
      setFlow(null);
      setError(message);
      // Keep the server's view (pending sign-in, connection) current for when this tab is shown again.
      router.refresh();
    };
    const tick = async (delaySec: number) => {
      timer.current = setTimeout(async () => {
        if (stopped) return;
        if (Date.now() > expiresAt) return stop("The code expired. Start again.");
        const r = await pollChatGPTConnect().catch(() => null);
        if (stopped) return;
        if (!r) {
          if (++failures >= MAX_POLL_FAILURES) return stop("Lost contact with the portal. Reload the page and try again.");
          return tick(delaySec * 2);
        }
        failures = 0;
        if (!r.ok) return stop(r.error);
        const v = r.value;
        if (v.status === "pending") return tick(v.intervalSec + 1);
        if (v.status === "connected") {
          stop(null);
          toast.success("ChatGPT connected");
        } else if (v.status === "failed") stop(v.error);
        else if (v.status === "expired") stop("The code expired. Start again.");
        // "none": finished elsewhere (another tab or device) or cancelled.
        else stop("This sign-in ended (finished or cancelled elsewhere).");
      }, delaySec * 1000);
    };
    void tick(flow.intervalSec + 1);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flow, router]);

  const connect = () =>
    start(async () => {
      setError(null);
      const r = await startChatGPTConnect();
      if (r.ok) {
        setFlow(r.value);
        router.refresh(); // so the pending sign-in is resumed if this tab is left and shown again
      } else setError(r.error);
    });

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium">
          ChatGPT <span className="ml-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">unofficial</span>
        </h2>
        <p className="mt-1 text-sm text-muted">
          Chat on your own ChatGPT plan in the portal&apos;s ChatGPT models. Usage counts against your plan&apos;s Codex limits. This uses OpenAI&apos;s
          Codex sign-in and private backend, so it may stop working. Your sign-in is stored encrypted and only used when you chat.
        </p>
      </div>

      {c && (
        <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-medium">{c.email ?? "ChatGPT account"}</div>
              <div className="text-xs text-muted">
                {c.plan} · workspace <span className="font-mono">{c.accountId}</span>
              </div>
            </div>
            {c.status === "active" ? (
              <span className="rounded-full bg-green-500/15 px-2 py-0.5 text-xs text-green-700 dark:text-green-300">Connected</span>
            ) : (
              <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-700 dark:text-red-300">Sign-in expired</span>
            )}
          </div>
          {c.status === "needs_reauth" && <p className="text-danger">Your ChatGPT sign-in expired or was revoked. Reconnect to keep using ChatGPT models.</p>}
          {c.rateLimits?.primary && <UsageBar w={c.rateLimits.primary} />}
          {c.rateLimits?.secondary && <UsageBar w={c.rateLimits.secondary} />}
          <div className="text-xs text-subtle">
            Connected {new Date(c.connectedAt).toLocaleDateString()}
            {c.lastRefreshAt ? ` · last refreshed ${new Date(c.lastRefreshAt).toLocaleString()}` : ""}
          </div>
          <div className="flex gap-2">
            {view.allowed && !flow && (
              <Button variant="outline" disabled={pending} onClick={connect}>
                Reconnect
              </Button>
            )}
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                if (!confirm("Disconnect your ChatGPT plan? You can connect it again later.")) return;
                start(async () => {
                  await disconnectChatGPT();
                  toast.success("Disconnected");
                  router.refresh();
                });
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {!c && !flow && view.allowed && (
        <Button disabled={pending} onClick={connect}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />} Connect ChatGPT
        </Button>
      )}
      {!view.allowed && !c && <p className="text-sm text-muted">Your organization hasn&apos;t enabled ChatGPT connections for you.</p>}

      {flow && (
        <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
          <p>
            1. Open{" "}
            <a href={flow.verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline">
              {flow.verificationUrl.replace(/^https?:\/\//, "")} <ExternalLink className="h-3 w-3" />
            </a>{" "}
            and sign in to ChatGPT.
          </p>
          <div className="flex items-center gap-3">
            <span>2. Enter this code:</span>
            <code aria-label="ChatGPT sign-in code" className="rounded-lg bg-hover px-3 py-1.5 font-mono text-lg tracking-widest">
              {flow.userCode}
            </code>
            <button
              type="button"
              aria-label="Copy code"
              className="rounded-lg p-1.5 text-muted hover:bg-hover"
              onClick={() => navigator.clipboard?.writeText(flow.userCode).then(() => toast.success("Copied"))}
            >
              <Copy className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-muted">
            OpenAI&apos;s page will say you&apos;re authorizing &quot;Codex&quot; — that&apos;s this portal. Only continue if you started this here; never enter
            a code someone else gave you. The code expires at {new Date(flow.expiresAt).toLocaleTimeString()}.
          </p>
          <div className="flex items-center gap-3 text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Waiting for you to finish signing in…
            <Button
              variant="ghost"
              onClick={() => {
                setFlow(null);
                void cancelChatGPTConnect()
                  .catch(() => {})
                  .finally(() => router.refresh());
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}
