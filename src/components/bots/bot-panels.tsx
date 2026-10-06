"use client";

import { LearnedItems } from "./learning-panel";
import type { LearningView } from "@/lib/agent/learning/types";
import { NativeResources } from "./native-resources";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Clock, Pencil, Pin, Plus, Sparkles, Trash2, Webhook } from "lucide-react";
import { deleteMemory, saveMemory, setMemoryPinned } from "@/app/(chat)/actions";
import { deleteSkill, saveSkill } from "@/app/(chat)/bots/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RoutineEditor, RunStatusIcon, scheduleText, type RoutineRow, type RunRow } from "./routine-editor";

type Skill = {
  id: string;
  botId: string | null;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  expectedOutput: string | null;
  boundaries: string | null;
  version: number;
  mine: boolean;
};

const TABS = ["Skills", "Routines", "Memory", "Activity"] as const;


function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

function StatusPill({ status }: { status: string }) {
  const color =
    status === "succeeded" || status === "done"
      ? "bg-green-500/15 text-green-700 dark:text-green-400"
      : status === "failed" || status === "error" || status === "denied"
        ? "bg-red-500/15 text-red-700 dark:text-red-400"
        : status === "awaiting_approval" || status === "pending_approval"
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          : "bg-surface-2 text-muted";
  return <span className={cn("rounded-full px-2 py-0.5 text-xs", color)}>{status.replace(/_/g, " ")}</span>;
}

function SkillDialog({ skill, botId, onClose }: { skill: Partial<Skill> | null; botId: string; onClose: () => void }) {
  const router = useRouter();
  const [s, setS] = useState<Partial<Skill>>(skill ?? {});
  const [pending, start] = useTransition();
  return (
    <Dialog open={!!skill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={s.id ? "Edit skill" : "New skill"} description="A proven procedure the bot follows when a request matches." className="max-w-2xl">
        <div className="space-y-4">
          <Field label="Name">
            <Input value={s.name ?? ""} onChange={(e) => setS({ ...s, name: e.target.value })} placeholder="Weekly status report" />
          </Field>
          <Field label="When to use it" hint="The bot sees this to decide when to load the skill.">
            <Input value={s.description ?? ""} onChange={(e) => setS({ ...s, description: e.target.value })} />
          </Field>
          <Field label="Steps & decision rules">
            <Textarea rows={8} value={s.instructions ?? ""} onChange={(e) => setS({ ...s, instructions: e.target.value })} placeholder={"1. …\n2. …\nIf X, then …"} />
          </Field>
          <Field label="Expected output">
            <Textarea rows={3} value={s.expectedOutput ?? ""} onChange={(e) => setS({ ...s, expectedOutput: e.target.value })} />
          </Field>
          <Field label="Boundaries">
            <Textarea rows={2} value={s.boundaries ?? ""} onChange={(e) => setS({ ...s, boundaries: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.botId === null} onChange={(e) => setS({ ...s, botId: e.target.checked ? null : botId })} />
            Share with all my bots
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending || !s.name || !s.description || !s.instructions}
              onClick={() =>
                start(async () => {
                  try {
                    await saveSkill({
                      id: s.id,
                      botId: s.botId === undefined ? botId : s.botId,
                      name: s.name!,
                      description: s.description!,
                      instructions: s.instructions!,
                      expectedOutput: s.expectedOutput,
                      boundaries: s.boundaries,
                    });
                    toast.success("Skill saved");
                    onClose();
                    router.refresh();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Save failed");
                  }
                })
              }
            >
              Save skill
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BotPanels({
  botId,
  canEdit,
  serviceMode = false,
  native = false,
  webhookBase,
  skills,
  learned = [],
  routines,
  runs,
  memories,
  activity,
}: {
  botId: string;
  canEdit: boolean;
  serviceMode?: boolean;
  native?: boolean;
  webhookBase: string;
  skills: Skill[];
  learned?: LearningView[];
  routines: RoutineRow[];
  runs: RunRow[];
  memories: { id: string; content: string; pinned: boolean }[];
  activity: { id: string; toolName: string; status: string; conversationId: string | null; createdAt: string }[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof TABS)[number]>(serviceMode ? "Activity" : "Skills");
  const [editSkill, setEditSkill] = useState<Partial<Skill> | null>(null);
  const [editRoutine, setEditRoutine] = useState<RoutineRow | "new" | null>(null);
  const learnedSkills = learned.filter(row => row.kind !== "preference");
  const learnedMemory = learned.filter(row => row.kind === "preference");
  const [newMemory, setNewMemory] = useState("");

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-border">
        {TABS.filter(t => (!serviceMode || t === "Activity") && (!native || t !== "Routines")).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t ? "border-fg font-medium" : "border-transparent text-muted hover:text-fg")}
          >
            {t}
          </button>
        ))}
      </div>

      {native && (tab === "Skills" || tab === "Memory") && <NativeResources botId={botId} section={tab} />}
      {!native && tab === "Skills" && (
        <div className="space-y-2">
          <p className="text-sm text-muted">Manual and learned procedures. Shared skills help everyone using this bot; Personal skills apply only to you. Policies marked Needs approval are not active.</p>
          {skills.map((s) => (
            <div key={s.id} className="flex items-start gap-3 rounded-xl border border-border p-3">
              <Sparkles className="mt-0.5 h-4 w-4 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {s.name} <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal text-muted">Manual</span> <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-normal text-muted">Shared</span>
                  <span className="ml-2 font-normal text-subtle">/{s.slug} · v{s.version}{s.botId === null ? " · available across the owner’s bots" : ""}</span>
                </div>
                <div className="text-sm text-muted">{s.description}</div>
              </div>
              {s.mine && (
                <div className="flex gap-1">
                  <button onClick={() => setEditSkill(s)} className="rounded-lg p-1.5 text-muted hover:bg-hover" aria-label="Edit skill">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    onClick={async () => {
                      if (!confirm("Delete skill?")) return;
                      await deleteSkill(s.id);
                      router.refresh();
                    }}
                    className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-danger"
                    aria-label="Delete skill"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          ))}
          <LearnedItems rows={learnedSkills} />
          {!skills.length && !learnedSkills.length && <p className="text-sm text-muted">No skills yet. Skills turn a workflow that worked into a repeatable procedure.</p>}
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setEditSkill({ botId })}>
              <Plus className="h-4 w-4" /> New skill
            </Button>
          )}
          <SkillDialog key={editSkill?.id ?? (editSkill ? "new" : "none")} skill={editSkill} botId={botId} onClose={() => setEditSkill(null)} />
        </div>
      )}

      {tab === "Routines" && (
        <div className="space-y-2">
          {routines.map((r) => {
            const last = runs.find((x) => x.routineId === r.id);
            return (
              <button
                key={r.id}
                onClick={() => setEditRoutine(r)}
                className="flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left hover:bg-hover/50"
              >
                {r.triggerType === "cron" ? <Clock className="h-4 w-4 text-muted" /> : <Webhook className="h-4 w-4 text-muted" />}
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {r.name} {!r.enabled && <span className="text-xs font-normal text-subtle">(paused)</span>}
                  </div>
                  <div className="text-xs text-muted">
                    {scheduleText(r)}
                    {r.triggerType === "cron" && r.enabled && r.nextRunAt ? ` · next ${fmt(r.nextRunAt)}` : ""}
                  </div>
                </div>
                {last && <RunStatusIcon status={last.status} />}
              </button>
            );
          })}
          {!routines.length && <p className="text-sm text-muted">No routines yet. Put this bot on a schedule or trigger it from another system.</p>}
          <Button variant="outline" size="sm" onClick={() => setEditRoutine("new")}>
            <Plus className="h-4 w-4" /> New routine
          </Button>
          {editRoutine && (
            <RoutineEditor
              key={editRoutine === "new" ? "new" : editRoutine.id}
              open
              onOpenChange={(o) => !o && setEditRoutine(null)}
              botId={botId}
              routine={editRoutine === "new" ? null : editRoutine}
              runs={runs}
              webhookBase={webhookBase}
              onChanged={() => router.refresh()}
            />
          )}
          {runs.length > 0 && (
            <div className="pt-6">
              <h3 className="mb-2 text-sm font-medium">Recent runs</h3>
              <div className="divide-y divide-border rounded-xl border border-border text-sm">
                {runs.map((run) => (
                  <div key={run.id} className="flex items-center gap-3 px-3 py-2">
                    <StatusPill status={run.status} />
                    <span className="text-muted">{routines.find((r) => r.id === run.routineId)?.name}</span>
                    <span className="text-xs text-subtle">{run.trigger}</span>
                    <span className="ml-auto text-xs text-subtle">{fmt(run.createdAt)}</span>
                    {run.conversationId && (
                      <Link href={`/c/${run.conversationId}`} className="text-xs underline">
                        Open
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!native && tab === "Memory" && (
        <div className="space-y-2">
          <p className="text-sm text-muted">Personal facts and preferences for this bot. These stay private to you. Memory in Settings can follow you across bots.</p>
          <LearnedItems rows={learnedMemory} />
          {memories.map((m) => (
            <div key={m.id} className="flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm">
              <span className="flex-1">{m.content}</span>
              <button
                onClick={async () => {
                  await setMemoryPinned(m.id, !m.pinned);
                  router.refresh();
                }}
                className={cn("rounded-lg p-1.5 hover:bg-hover", m.pinned ? "text-accent" : "text-muted")}
                aria-label="Pin memory"
              >
                <Pin className="h-4 w-4" />
              </button>
              <button
                onClick={async () => {
                  await deleteMemory(m.id);
                  router.refresh();
                }}
                className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-danger"
                aria-label="Delete memory"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newMemory.trim()) return;
              await saveMemory({ content: newMemory, botId });
              setNewMemory("");
              router.refresh();
            }}
          >
            <Input value={newMemory} onChange={(e) => setNewMemory(e.target.value)} placeholder="Add something for this bot to remember…" />
            <Button type="submit" variant="outline">
              Add
            </Button>
          </form>
        </div>
      )}

      {tab === "Activity" && (
        <div className="divide-y divide-border rounded-xl border border-border text-sm">
          {activity.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-xs">{a.toolName}</span>
              <StatusPill status={a.status} />
              <span className="ml-auto text-xs text-subtle">{fmt(a.createdAt)}</span>
              {a.conversationId && (
                <Link href={`/c/${a.conversationId}`} className="text-xs underline">
                  Open
                </Link>
              )}
            </div>
          ))}
          {!activity.length && <p className="p-3 text-muted">No tool activity yet.</p>}
        </div>
      )}
    </div>
  );
}
