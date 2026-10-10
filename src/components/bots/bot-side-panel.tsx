"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Clock, FileText, Monitor, PanelRightClose, Plus, Settings2, Webhook } from "lucide-react";
import { getBotPanelData } from "@/app/(chat)/bots/actions";
import type { TargetOption } from "@/components/chat/types";
import { Tip } from "@/components/ui/tooltip";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { BotPortrait } from "@/components/bots/bot-portrait";
import { BotPetSettings } from "@/components/pets/bot-pet";
import { RoutineEditor, RunStatusIcon, scheduleText, type RoutineRow, type RunRow } from "./routine-editor";
import { ShareTemplateButton } from "./share-template";
import { UseAsTemplateButton } from "./template-button";

type PanelData = Awaited<ReturnType<typeof getBotPanelData>>;

/** Right-hand panel next to a bot chat, modelled on Grok Bot's layout (bot card + Routines). */
export function BotSidePanel({ bot, onClose, panelId, mobile = false }: { bot: TargetOption; onClose: () => void; panelId: string; mobile?: boolean }) {
  const [data, setData] = useState<PanelData | null>(null);
  const [failed, setFailed] = useState(false);
  const [edit, setEdit] = useState<RoutineRow | "new" | null>(null);

  const load = useCallback(() => {
    getBotPanelData(bot.id)
      .then((next) => { setData(next); setFailed(false); })
      .catch(() => setFailed(true));
  }, [bot.id]);
  useEffect(() => {
    let mounted = true;
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden" || (!mobile && !window.matchMedia("(min-width: 1024px)").matches)) return;
      pending = true;
      try { const next = await getBotPanelData(bot.id); if (mounted) { setData(next); setFailed(false); } }
      catch { if (mounted) setFailed(true); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { mounted = false; clearInterval(timer); };
  }, [bot.id, mobile]);

  const runs: RunRow[] = data?.runs ?? [];
  const state = !data ? null : data.state.awaitingApproval ? "waiting" : data.state.working ? "working" : data.activity.some((r) => ["failed", "interrupted"].includes(r.status)) ? "attention" : "idle";
  const statusText = state === null ? "Loading…" : state === "waiting" ? "Needs your approval" : state === "working" ? "Working" : state === "attention" ? "Needs attention" : "Idle";
  const quiet = !!data && !data.activity.length && !data.outputs.length;

  return (
    <aside aria-label={`${bot.name} activity and outputs`} className={`flex h-full min-h-0 min-w-0 shrink-0 flex-col ${mobile ? "w-full" : "w-[300px] border-l border-border bg-bg"}`}>
      <div className="flex h-14 shrink-0 items-center justify-end gap-1 px-2">
        {data?.canEdit && (
          <Tip label="Bot settings">
            <Link href={`/bots/${bot.id}/edit`} className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg" aria-label="Bot settings">
              <Settings2 className="h-5 w-5" />
            </Link>
          </Tip>
        )}
        <button onClick={onClose} title="Hide bot details" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fg" aria-label="Hide bot details" aria-expanded="true" aria-controls={panelId}>
          <PanelRightClose aria-hidden className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {/* Who this is, without a card: Grok Bot keeps the panel flat. */}
        <div className="flex items-center gap-3">
          <BotAvatar botId={bot.id} activity={state === "waiting" ? "approval" : state === "working" ? "working" : undefined} value={bot.icon} size={56} state={state === "working" ? "working" : state === "waiting" ? "waiting" : "idle"} className="h-14 w-14" />
          <div className="min-w-0">
            <div className="truncate font-medium">{bot.name}</div>
            <div className={`truncate text-xs ${state === "waiting" ? "text-warn" : state === "working" ? "text-working" : state === "attention" ? "text-danger" : "text-subtle"}`}>
              {statusText}
              {bot.label ? ` · ${bot.label}` : ""}
            </div>
          </div>
        </div>
        <div className="mt-3"><BotPetSettings botId={bot.id} botName={bot.name} botAvatar={bot.icon} /></div>
        {bot.description && <p className="mt-3 line-clamp-3 text-xs text-muted">{bot.description}</p>}
        <Link href={`/bots/${bot.id}`} className="mt-2 inline-block text-xs text-muted hover:text-fg hover:underline">
          {data?.personalHermes ? "Skills, memory & activity" : data?.localEngine ? "Local Hermes profile & engine" : data?.serviceMode ? "Activity" : "Skills, memory & activity"}
        </Link>

        {data?.workspace && <WorkspaceScreen bot={bot} preview={data.workspace} busy={state === "working"} />}

        {failed && <p role="status" className="mt-3 text-xs text-muted">Activity could not be refreshed. <button onClick={load} className="underline">Retry</button></p>}
        {!!data?.activity.length && (
          <section className="mt-6" aria-label="Recent activity">
            <h3 className="px-2 text-xs font-medium text-subtle">Recent activity</h3>
            <div className="mt-1 space-y-0.5">
              {data.activity.map((r) => <Link key={r.id} href={`/c/${r.conversationId}`} onClick={mobile ? onClose : undefined} title={r.title} className="flex items-start gap-2 rounded-lg px-2 py-2 text-sm hover:bg-hover">
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${r.status === "running" || r.status === "queued" || r.status === "waiting_tasks" ? "bg-working motion-safe:animate-pulse" : r.status === "waiting" ? "bg-warn" : r.status === "failed" || r.status === "interrupted" ? "bg-danger" : "bg-subtle/40"}`} />
                <span className="min-w-0 flex-1"><span className="block truncate">{r.title}</span><span className="text-xs text-subtle">{r.kind === "delegation" ? "Delegated task · " : r.kind === "routine" ? "Routine · " : r.kind === "background" ? "Background work · " : ""}{r.status === "waiting_tasks" ? "Waiting for tasks" : r.status === "waiting" ? "Needs approval" : r.status === "succeeded" ? "Completed" : r.status === "queued" ? "Queued" : r.status.charAt(0).toUpperCase() + r.status.slice(1)}{r.unread ? " · Unread" : ""}</span></span>
              </Link>)}
            </div>
          </section>
        )}
        {!!data?.outputs.length && (
          <section className="mt-6" aria-label="Outputs">
            <h3 className="px-2 text-xs font-medium text-subtle">Outputs</h3>
            <div className="mt-1 space-y-0.5">
              {data.outputs.map((o) => <Link key={`${o.kind}:${o.id}`} href={o.href} onClick={mobile ? onClose : undefined} prefetch={false} title={o.title} className="flex items-start gap-2 rounded-lg px-2 py-2 text-sm hover:bg-hover">
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-subtle" />
                <span className="min-w-0"><span className="block truncate">{o.title}</span><span className="text-xs text-subtle">File</span></span>
              </Link>)}
            </div>
          </section>
        )}
        {quiet && <p className="mt-6 px-2 text-xs text-subtle">{data?.localEngine ? "Hermes owns this bot's skills, memory and native sessions." : "Nothing needs attention. Active work, routine results and files will show up here."}</p>}

        {data?.serviceMode && <p className="mt-6 px-2 text-xs text-muted">Admin-managed service bot. Direct chats only; routines are unavailable.</p>}
        {data?.personalHermes && <p className="mt-6 px-2 text-xs text-muted">Private native Hermes profile. <Link href="/settings?tab=connected-accounts" className="underline">Runtime status</Link></p>}
        {data?.localEngine && !data.personalHermes && <p className="mt-6 px-2 text-xs text-muted">Private Local Hermes pilot. Direct text chats, native tool approvals and Stop are available. <Link href="/admin/hermes" className="underline">Engine controls</Link></p>}
        {data && !data.serviceMode && !data.localEngine && <><div className="mt-6 flex items-center justify-between px-2">
          <h3 className="text-xs font-medium text-subtle">Routines</h3>
          <Tip label="New routine">
            <button onClick={() => setEdit("new")} className="rounded-lg p-1 text-muted hover:bg-hover hover:text-fg" aria-label="New routine">
              <Plus className="h-4 w-4" />
            </button>
          </Tip>
        </div>
        <div className="mt-1 space-y-0.5">
          {data?.routines.map((r) => {
            const last = runs.find((x) => x.routineId === r.id);
            return (
              <button key={r.id} onClick={() => setEdit(r)} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover">
                {r.triggerType === "cron" ? (
                  <Clock className={`mt-0.5 h-4 w-4 shrink-0 ${r.enabled ? "text-success" : "text-subtle"}`} />
                ) : (
                  <Webhook className={`mt-0.5 h-4 w-4 shrink-0 ${r.enabled ? "text-success" : "text-subtle"}`} />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{r.name}</span>
                  <span className="block truncate text-xs text-muted">{r.enabled ? scheduleText(r) : "Paused"}</span>
                </span>
                {last && <RunStatusIcon status={last.status} />}
              </button>
            );
          })}
          {data && !data.routines.length && (
            <button onClick={() => setEdit("new")} className="w-full rounded-lg px-2 py-1.5 text-left text-xs text-subtle hover:bg-hover hover:text-fg">
              Put {bot.name} on a schedule — results land in your Inbox.
            </button>
          )}
        </div>

        </>}
        {data && !data.localEngine && <div className="mt-6 flex flex-wrap gap-2">
          <UseAsTemplateButton botId={bot.id} className="flex-auto justify-center whitespace-nowrap px-3 py-2 text-xs" />
          {data?.canEdit && (
            <ShareTemplateButton
              botId={bot.id}
              className="flex flex-auto items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border px-3 py-2 text-xs font-medium hover:bg-hover"
            />
          )}
        </div>}
        <BotPortrait botId={bot.id} />
      </div>
      {edit && !data?.serviceMode && !data?.localEngine && (
        <RoutineEditor
          key={edit === "new" ? "new" : edit.id}
          open
          onOpenChange={(o) => !o && setEdit(null)}
          botId={bot.id}
          routine={edit === "new" ? null : edit}
          runs={runs}
          onChanged={load}
        />
      )}
    </aside>
  );
}

/** The bot's "screen" (Grok Bot shows its computer): the latest command it ran in your workspace and how it ended. */
function WorkspaceScreen({ bot, preview, busy }: { bot: TargetOption; preview: NonNullable<PanelData["workspace"]>; busy: boolean }) {
  const label = busy ? "Working" : preview.state === "running" ? "Running" : preview.state === "stopped" ? "Stopped" : preview.state === "unavailable" ? "Unavailable" : "Not started";
  return (
    <section className="mt-5" aria-label={`${bot.name}'s workspace`}>
      <Link
        href="/settings?tab=workspace"
        className={`block overflow-hidden rounded-xl border bg-[#0d0d0d] p-3 font-mono text-[10.5px] leading-4 text-[#d4d4d4] ${busy ? "border-working shadow-[0_0_0_3px_color-mix(in_srgb,var(--working)_25%,transparent)]" : "border-border"}`}
      >
        <div className="mb-2 flex items-center gap-1.5" aria-hidden>
          <span className="h-2 w-2 rounded-full bg-[#ff5f57]" />
          <span className="h-2 w-2 rounded-full bg-[#febc2e]" />
          <span className="h-2 w-2 rounded-full bg-[#28c840]" />
          <Monitor className="ml-auto h-3 w-3 text-[#8a8a8a]" />
        </div>
        <div className="h-28 overflow-hidden">
          {preview.command ? (
            <>
              <div className="truncate text-[#86efac]">$ {preview.command}</div>
              {preview.lines.map((l, i) => <div key={i} className="truncate">{l}</div>)}
              {busy && <span className="inline-block h-3 w-1.5 bg-[#d4d4d4] motion-safe:animate-pulse align-middle" />}
            </>
          ) : (
            <div className="text-[#8a8a8a]">No commands yet. When {bot.name} works in your workspace, it shows here.</div>
          )}
        </div>
      </Link>
      <div className="mt-1.5 text-center text-xs text-subtle">
        {bot.name}&apos;s workspace · <span className={busy ? "text-working" : undefined}>{label}</span>
        {preview.ok === false && !busy ? " · last command failed" : ""}
      </div>
    </section>
  );
}
