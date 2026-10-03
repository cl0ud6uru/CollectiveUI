"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Link2, Loader2, RefreshCw, Share2 } from "lucide-react";
import { createBotTemplate, getBotTemplate, revokeBotTemplate, updateBotTemplate } from "@/app/(chat)/bots/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

/** Share → Create template: a sign-in-only link others can use to add their own copy of this bot. */
export function ShareTemplateButton({ botId, className }: { botId: string; className?: string }) {
  const [state, setState] = useState<{ token: string; updatedAt: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const url = state ? `${typeof window !== "undefined" ? location.origin : ""}/templates/${state.token}` : "";

  async function run(fn: () => Promise<{ token: string; updatedAt: string } | null | void>, ok?: string) {
    setBusy(true);
    try {
      const r = await fn();
      setState(r ?? null);
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onOpenChange={(o) => o && state === undefined && run(() => getBotTemplate(botId))}>
      <DialogTrigger asChild>
        <button className={className ?? "flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium hover:bg-hover"}>
          <Share2 className="h-4 w-4" /> Share template
        </button>
      </DialogTrigger>
      <DialogContent
        title="Share as template"
        description="Anyone in your organization with the link can preview this bot and add their own copy: identity, description, instructions, skills, tools and routines. They don't get your conversations, memory, knowledge files or sign-ins."
      >
        <div className="mb-4 flex gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Remove API keys, internal URLs, customer data and anything else you wouldn&apos;t put in a shared document before sharing.
        </div>
        {state === undefined ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted" />
        ) : state ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-full border border-border p-1.5 pl-4">
              <span className="flex-1 truncate text-sm text-muted">{url}</span>
              <Button
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(url).catch(() => {});
                  toast.success("Link copied");
                }}
              >
                Copy link
              </Button>
            </div>
            <p className="text-xs text-subtle">Snapshot from {new Date(state.updatedAt).toLocaleString()}. Changes to the bot aren&apos;t shared until you update the template.</p>
            <div className="flex flex-wrap gap-2">
              <a href={url} target="_blank" rel="noreferrer" className="rounded-full border border-border px-3 py-1.5 text-sm hover:bg-hover">
                View template details
              </a>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run(() => updateBotTemplate(botId), "Template updated")}>
                <RefreshCw className="h-4 w-4" /> Update template
              </Button>
              <Button size="sm" variant="ghost" className="text-danger" disabled={busy} onClick={() => run(async () => void (await revokeBotTemplate(botId)), "Link revoked")}>
                Revoke link
              </Button>
            </div>
          </div>
        ) : (
          <Button disabled={busy} onClick={() => run(() => createBotTemplate(botId), "Template link created")}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Create template
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
