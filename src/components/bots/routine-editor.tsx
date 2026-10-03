"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Dialog as D } from "radix-ui";
import { toast } from "sonner";
import { AlertTriangle, Check, Clock, Loader2, Pause, X } from "lucide-react";
import { deleteRoutine, runRoutineNow, saveRoutine } from "@/app/(chat)/bots/actions";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { buildCron, cronToText, parseCron, type Frequency } from "@/lib/cron-text";

export type RoutineRow = {
  id: string;
  name: string;
  prompt: string;
  triggerType: "cron" | "webhook";
  cron: string | null;
  timezone: string;
  enabled: boolean;
  notifyEmail: boolean;
  webhookSecret: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
};
export type RunRow = { id: string; routineId: string; status: string; trigger: string; conversationId: string | null; error: string | null; createdAt: string };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function relativeTime(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export function RunStatusIcon({ status }: { status: string }) {
  if (status === "succeeded") return <Check className="h-4 w-4 text-green-600" aria-label="succeeded" />;
  if (status === "failed") return <AlertTriangle className="h-4 w-4 text-danger" aria-label="failed" />;
  if (status === "awaiting_approval") return <Pause className="h-4 w-4 text-amber-500" aria-label="awaiting approval" />;
  return <Loader2 className="h-4 w-4 animate-spin text-muted" aria-label={status} />;
}

export function scheduleText(r: Pick<RoutineRow, "triggerType" | "cron">) {
  return r.triggerType === "webhook" ? "When the webhook is called" : cronToText(r.cron);
}

/** Grok Bot-style routine sheet: Active toggle, Test run, instruction, friendly "When to run", run history. */
export function RoutineEditor({
  open,
  onOpenChange,
  botId,
  routine,
  runs,
  webhookBase,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  botId: string;
  routine: RoutineRow | null; // null = new
  runs: RunRow[];
  webhookBase?: string;
  onChanged: () => void;
}) {
  const tzDefault = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [notifyEmail, setNotifyEmail] = useState(routine?.notifyEmail ?? false);
  const [triggerType, setTriggerType] = useState<"cron" | "webhook">(routine?.triggerType ?? "cron");
  const [timezone, setTimezone] = useState(routine?.timezone ?? tzDefault);
  const [sched, setSched] = useState(() => parseCron(routine?.cron ?? "0 9 * * 1-5"));
  const [pending, start] = useTransition();
  const [testing, setTesting] = useState(false);
  const cron = buildCron(sched);
  const myRuns = routine ? runs.filter((r) => r.routineId === routine.id).slice(0, 8) : [];
  const base = webhookBase || (typeof window !== "undefined" ? `${location.origin}/api/routines/webhook` : "");

  function save(extra?: { enabled?: boolean }) {
    start(async () => {
      try {
        await saveRoutine({
          id: routine?.id,
          botId,
          name: name.trim(),
          prompt: prompt.trim(),
          triggerType,
          cron: triggerType === "cron" ? cron : null,
          timezone,
          enabled: extra?.enabled ?? enabled,
          notifyEmail,
        });
        toast.success("Routine saved");
        onChanged();
        if (!extra) onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col bg-dialog shadow-2xl outline-none">
          <D.Title className="sr-only">Routine</D.Title>
          <D.Description className="sr-only">Edit routine</D.Description>
          <div className="flex h-14 items-center justify-between border-b border-border px-4">
            <span className="font-medium">Routine</span>
            <D.Close className="rounded-lg p-1.5 text-muted hover:bg-hover" aria-label="Close">
              <X className="h-5 w-5" />
            </D.Close>
          </div>
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={enabled}
                  onCheckedChange={(v) => {
                    setEnabled(v);
                    if (routine) save({ enabled: v });
                  }}
                />
                {enabled ? "Active" : "Paused"}
              </label>
              <div className="ml-auto flex gap-2">
                {routine && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      if (!confirm("Delete this routine?")) return;
                      await deleteRoutine(routine.id);
                      onChanged();
                      onOpenChange(false);
                    }}
                  >
                    Delete
                  </Button>
                )}
                {routine && (
                  <Button
                    size="sm"
                    disabled={testing}
                    onClick={async () => {
                      setTesting(true);
                      try {
                        await runRoutineNow(routine.id);
                        toast.success("Test run started — the result will land in your Inbox");
                        onChanged();
                      } catch (err) {
                        toast.error(err instanceof Error ? err.message : "Could not start");
                      } finally {
                        setTesting(false);
                      }
                    }}
                  >
                    {testing && <Loader2 className="h-4 w-4 animate-spin" />} Test run
                  </Button>
                )}
              </div>
            </div>

            <div>
              <div className="mb-1.5 text-sm text-muted">Name</div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning inbox triage" />
            </div>
            <div>
              <div className="mb-1.5 text-sm text-muted">Instruction</div>
              <Textarea
                rows={6}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the bot do each time? Write it as a complete task — no one is watching live."
              />
            </div>

            <div>
              <div className="mb-1.5 text-sm text-muted">When to run</div>
              <div className="space-y-3 rounded-2xl border border-border p-3">
                <Select value={triggerType} onChange={(e) => setTriggerType(e.target.value as "cron" | "webhook")} aria-label="Trigger">
                  <option value="cron">On a schedule</option>
                  <option value="webhook">When another system calls a webhook</option>
                </Select>
                {triggerType === "cron" ? (
                  <>
                    <div className="flex gap-2">
                      <Select value={sched.frequency} onChange={(e) => setSched({ ...sched, frequency: e.target.value as Frequency })} aria-label="Frequency">
                        <option value="daily">Every day</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="weekly">Every week</option>
                        <option value="monthly">Every month</option>
                        <option value="hourly">Every hour</option>
                        <option value="minutes">Every few minutes</option>
                        <option value="custom">Custom (cron)</option>
                      </Select>
                      {["daily", "weekdays", "weekly", "monthly"].includes(sched.frequency) && (
                        <Input type="time" value={sched.time} onChange={(e) => setSched({ ...sched, time: e.target.value })} className="w-32" aria-label="Time" />
                      )}
                    </div>
                    {sched.frequency === "weekly" && (
                      <Select value={sched.weekday} onChange={(e) => setSched({ ...sched, weekday: Number(e.target.value) })} aria-label="Day of week">
                        {WEEKDAYS.map((d, i) => (
                          <option key={d} value={i}>
                            on {d}
                          </option>
                        ))}
                      </Select>
                    )}
                    {sched.frequency === "monthly" && (
                      <Select value={sched.dayOfMonth} onChange={(e) => setSched({ ...sched, dayOfMonth: Number(e.target.value) })} aria-label="Day of month">
                        {Array.from({ length: 28 }, (_, i) => (
                          <option key={i} value={i + 1}>
                            on day {i + 1}
                          </option>
                        ))}
                      </Select>
                    )}
                    {sched.frequency === "minutes" && (
                      <Select value={sched.minutes} onChange={(e) => setSched({ ...sched, minutes: Number(e.target.value) })} aria-label="Interval">
                        {[5, 10, 15, 30].map((m) => (
                          <option key={m} value={m}>
                            every {m} minutes
                          </option>
                        ))}
                      </Select>
                    )}
                    {sched.frequency === "custom" && (
                      <Input value={sched.custom} onChange={(e) => setSched({ ...sched, custom: e.target.value })} placeholder="0 8 * * 1-5" className="font-mono" />
                    )}
                    <div className="flex items-center gap-2 text-sm">
                      <Clock className="h-4 w-4 text-muted" />
                      <span>{cronToText(cron)}</span>
                    </div>
                    <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="h-8 text-xs" aria-label="Timezone" />
                  </>
                ) : routine?.webhookSecret ? (
                  <div className="space-y-1 break-all rounded-lg bg-surface-2 p-2 font-mono text-xs">
                    <div>POST {base}/{routine.id}</div>
                    <div className="text-muted">Authorization: Bearer {routine.webhookSecret}</div>
                    <div className="text-muted">or X-Portal-Signature: sha256=HMAC(secret, body)</div>
                  </div>
                ) : (
                  <p className="text-xs text-muted">Save to get the webhook URL and secret.</p>
                )}
              </div>
            </div>

            <label className="flex items-center justify-between text-sm">
              Email me the result (Microsoft 365)
              <Switch checked={notifyEmail} onCheckedChange={setNotifyEmail} />
            </label>

            {routine && (
              <div>
                <div className="mb-1.5 text-sm text-muted">Run history</div>
                <div className="space-y-0.5">
                  {myRuns.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm">
                      <span className="flex-1">{relativeTime(r.createdAt)}</span>
                      <span className="text-xs text-subtle">{r.trigger}</span>
                      {r.conversationId ? (
                        <Link href={`/c/${r.conversationId}`} title={r.error ?? r.status} onClick={() => onOpenChange(false)}>
                          <RunStatusIcon status={r.status} />
                        </Link>
                      ) : (
                        <RunStatusIcon status={r.status} />
                      )}
                    </div>
                  ))}
                  {!myRuns.length && <p className="text-sm text-subtle">No runs yet.</p>}
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-border p-4">
            <Button className="w-full" disabled={pending || !name.trim() || !prompt.trim()} onClick={() => save()}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} {routine ? "Save changes" : "Create routine"}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
