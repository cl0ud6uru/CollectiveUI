"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { adminDestroyOrphan, adminDestroySandbox, adminStopSandbox, saveSandboxSettings } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { SandboxSettings } from "@/lib/settings";
import type { WorkspaceSetupReport } from "@/lib/sandbox/setup";
import { GroupPicker } from "./group-picker";
import { Badge, Card, Table, Td } from "./ui";
import { WorkspaceSetup } from "./workspace-setup";

export type SandboxRowView = {
  userId: string;
  name: string;
  upn: string;
  disabled: boolean;
  state: "running" | "stopped" | "missing" | "unknown";
  runtime: "runc" | "runsc" | null;
  activeExecs: number;
  drift: boolean;
  lastUsedAt: string | null;
  deleteAfter: string | null;
};

const toLines = (v: string) => v.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean);

export function SandboxAdmin({
  settings,
  groups,
  setup,
  error,
  rows,
  orphans,
}: {
  settings: SandboxSettings;
  groups: { id: string; name: string }[];
  setup: WorkspaceSetupReport;
  error: string | null;
  rows: SandboxRowView[];
  orphans: { ref: string; state: string; createdAt: string | null }[];
}) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [upns, setUpns] = useState(settings.allowedUpns.join("\n"));
  const [ack, setAck] = useState(false);
  const [enableAck, setEnableAck] = useState(false);
  const [checkedReport, setCheckedReport] = useState<{ initial: WorkspaceSetupReport; report: WorkspaceSetupReport } | null>(null);
  // A refreshed server report supersedes a manual check, including after isolation settings change.
  const report = checkedReport?.initial === setup ? checkedReport.report : setup;
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof SandboxSettings>(k: K, v: SandboxSettings[K]) => { setEnableAck(false); setS((x) => ({ ...x, [k]: v })); };
  const needsAck = s.allowRunc && !settings.allowRunc;
  const needsEnableAck = s.enabled && !settings.enabled;

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        setFeedback({ ok: true, message: ok });
        setEnableAck(false); setAck(false);
        toast.success(ok);
        router.refresh();
      } catch (err) {
        setFeedback({ ok: false, message: err instanceof Error ? err.message : "Failed" });
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });

  return (
    <div className="space-y-6">
      <WorkspaceSetup report={report} enabled={settings.enabled} onChecked={(next) => { setCheckedReport({ initial: setup, report: next }); setEnableAck(false); }} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <Card className="space-y-4">
        <h2 className="font-medium">Settings</h2>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm">
          Give people workspaces (bots with the Workspace tool can use them)
          <Switch aria-label="Enable workspaces" checked={s.enabled} disabled={!s.enabled && !report.ready} onCheckedChange={(v) => set("enabled", v)} />
        </label>
        {!report.ready && !s.enabled && <p className="text-xs text-muted">Resolve the setup checks before enabling access. You can save access assignments and limits while access is off.</p>}
        <Field label="Who gets a workspace" hint="Admins always do while this is on.">
          <Select aria-label="Who gets a workspace" value={s.access} onChange={(e) => set("access", e.target.value as SandboxSettings["access"])}>
            <option value="selected">Selected groups and people</option>
            <option value="everyone">Everyone</option>
          </Select>
        </Field>
        {s.access === "selected" && (
          <>
            <GroupPicker groups={groups} value={s.allowedGroupIds} onChange={(v) => set("allowedGroupIds", v)} />
            <Field label="People (UPNs)" hint="One per line.">
              <Textarea aria-label="Allowed people" rows={3} value={upns} onChange={(e) => { setEnableAck(false); setUpns(e.target.value); }} className="font-mono" />
            </Field>
          </>
        )}
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm">
          <span>
            Allow standard isolation (runc) when gVisor isn&apos;t available
            <span className="block text-xs text-muted">
              Sandboxes still have no network, no capabilities and a read-only system, but share the host kernel. gVisor is recommended.
            </span>
          </span>
          <Switch aria-label="Allow standard isolation" checked={s.allowRunc} onCheckedChange={(v) => set("allowRunc", v)} />
        </label>
        {needsAck && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />I understand workspaces without gVisor share the
            host&apos;s kernel, so a kernel vulnerability could let a command escape its sandbox.
          </label>
        )}
        {settings.allowRunc && settings.runcAcknowledgedAt && (
          <p className="text-xs text-subtle">
            Standard isolation allowed by {settings.runcAcknowledgedBy} on {settings.runcAcknowledgedAt.slice(0, 10)}.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Command time limit (seconds)">
            <Input aria-label="Command time limit" type="number" min={5} max={3600} value={s.commandTimeoutSec} onChange={(e) => set("commandTimeoutSec", Number(e.target.value))} />
          </Field>
          <Field label="Output kept per command (KB)">
            <Input aria-label="Output kept" type="number" min={4} max={1024} value={s.outputKb} onChange={(e) => set("outputKb", Number(e.target.value))} />
          </Field>
          <Field label="Keep a disabled person's files (days)">
            <Input aria-label="Retention days" type="number" min={0} max={3650} value={s.deleteAfterDays} onChange={(e) => set("deleteAfterDays", Number(e.target.value))} />
          </Field>
        </div>
        {needsEnableAck && <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" aria-label="Confirm workspace access" className="mt-1" checked={enableAck} onChange={(e) => setEnableAck(e.target.checked)} />
          <span>I confirm workspace access for {s.access === "everyone" ? "everyone" : `${s.allowedGroupIds.length} selected groups and ${toLines(upns).length} selected people`}, plus all admins. Containers and persistent files are created on first use. I have reviewed host storage monitoring and will test a native bot before expanding access.</span>
        </label>}
        {feedback && <p role={feedback.ok ? "status" : "alert"} className={`text-sm ${feedback.ok ? "text-success" : "text-danger"}`}>{feedback.message}</p>}
        <div className="flex justify-end">
          <Button
            disabled={pending || (needsAck && !ack) || (needsEnableAck && (!enableAck || !report.ready))}
            onClick={() =>
              run(
                () =>
                  saveSandboxSettings({
                    enabled: s.enabled,
                    acknowledgeEnable: enableAck,
                    access: s.access,
                    allowedGroupIds: s.allowedGroupIds,
                    allowedUpns: toLines(upns),
                    allowRunc: s.allowRunc,
                    acknowledgeRunc: ack,
                    commandTimeoutSec: s.commandTimeoutSec,
                    outputKb: s.outputKb,
                    deleteAfterDays: s.deleteAfterDays,
                  }),
                "Saved",
              )
            }
          >
            Save workspace settings
          </Button>
        </div>
      </Card>

      <Table head={["Person", "State", "Isolation", "Last used", ""]}>
        {rows.map((r) => (
          <tr key={r.userId}>
            <Td>
              <div className="font-medium">{r.name}</div>
              <div className="text-xs text-muted">
                {r.upn}
                {r.disabled && " · disabled"}
              </div>
            </Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                <Badge tone={r.state === "running" ? "green" : r.state === "unknown" ? "red" : "default"}>{r.state === "missing" ? "not created" : r.state}</Badge>
                {r.activeExecs > 0 && <Badge tone="blue">{r.activeExecs} running</Badge>}
                {r.drift && <Badge tone="amber">update pending</Badge>}
                {r.deleteAfter && <Badge tone="red">deleted {r.deleteAfter.slice(0, 10)}</Badge>}
              </div>
            </Td>
            <Td className="text-xs text-muted">{r.runtime === "runsc" ? "gVisor" : r.runtime === "runc" ? "standard" : "—"}</Td>
            <Td className="text-xs text-muted">{r.lastUsedAt ? new Date(r.lastUsedAt).toLocaleString() : "never"}</Td>
            <Td className="whitespace-nowrap">
              <Button size="sm" variant="ghost" disabled={pending || r.state !== "running"} onClick={() => run(() => adminStopSandbox(r.userId), "Stopped")}>
                Stop
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-danger"
                aria-label={`Destroy ${r.name}'s workspace`}
                disabled={pending}
                onClick={() => confirm(`Delete ${r.name}'s workspace and all its files?`) && run(() => adminDestroySandbox(r.userId), "Workspace deleted")}
              >
                Destroy
              </Button>
            </Td>
          </tr>
        ))}
        {!rows.length && (
          <tr>
            <Td colSpan={5} className="py-8 text-center text-muted">
              No workspaces yet.
            </Td>
          </tr>
        )}
      </Table>

      {orphans.length > 0 && (
        <Card className="space-y-2 text-sm">
          <div className="font-medium">Sandboxes without an owner</div>
          <p className="text-xs text-muted">Left behind by deleted accounts. The hourly cleanup removes them; you can remove them now.</p>
          {orphans.map((o) => (
            <div key={o.ref} className="flex items-center gap-3">
              <code className="font-mono text-xs">{o.ref}</code>
              <Badge>{o.state}</Badge>
              <Button size="sm" variant="ghost" className="text-danger" disabled={pending} onClick={() => run(() => adminDestroyOrphan(o.ref), "Removed")}>
                Remove
              </Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
