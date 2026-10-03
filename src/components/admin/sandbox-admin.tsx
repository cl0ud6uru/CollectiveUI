"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { adminDestroyOrphan, adminDestroySandbox, adminStopSandbox, saveSandboxSettings } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { SandboxSettings } from "@/lib/settings";
import type { Health } from "@/sandboxd/protocol/types";
import { GroupPicker } from "./group-picker";
import { Badge, Card, Table, Td } from "./ui";

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

function HealthBanner({ configured, health, error, allowRunc }: { configured: boolean; health: Health | null; error: string | null; allowRunc: boolean }) {
  if (!configured)
    return (
      <Card className="border-amber-500/40 text-sm">
        Workspaces aren&apos;t set up: run sandboxd on the Docker host and set <code className="font-mono">SANDBOXD_URL</code> and{" "}
        <code className="font-mono">SANDBOXD_SECRET</code> for the portal (see README → Workspaces).
      </Card>
    );
  if (error || !health) return <Card className="border-red-500/40 text-sm text-danger">{error ?? "The workspace service isn't reachable."}</Card>;
  const blocked = !health.gvisor.available && !allowRunc;
  return (
    <Card className={`space-y-2 text-sm ${blocked ? "border-red-500/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Sandbox service</span>
        <Badge tone={health.ok ? "green" : "red"}>{health.ok ? "healthy" : "not ready"}</Badge>
        <Badge tone={health.gvisor.available ? "green" : "amber"}>{health.gvisor.available ? "gVisor isolation" : "no gVisor"}</Badge>
        <span className="text-xs text-muted">
          Docker {health.docker?.version} · {health.running}/{health.limits.maxRunning} running · {health.limits.memoryMb} MB, {health.limits.cpus} CPU,{" "}
          {health.limits.pids} processes each · stop after {health.limits.idleMinutes} min idle
        </span>
      </div>
      {!health.image.present && <p className="text-danger">The sandbox image {health.image.ref} isn&apos;t on the Docker host (npm run sandbox:image).</p>}
      {blocked && (
        <p className="text-danger">
          Workspaces can&apos;t start: gVisor isn&apos;t available ({health.gvisor.reason}). Install gVisor on the Docker host (recommended), or allow standard
          isolation below.
        </p>
      )}
      {health.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-700 dark:text-amber-300">
          {w}
        </p>
      ))}
    </Card>
  );
}

export function SandboxAdmin({
  settings,
  groups,
  configured,
  health,
  error,
  rows,
  orphans,
}: {
  settings: SandboxSettings;
  groups: { id: string; name: string }[];
  configured: boolean;
  health: Health | null;
  error: string | null;
  rows: SandboxRowView[];
  orphans: { ref: string; state: string; createdAt: string | null }[];
}) {
  const router = useRouter();
  const [s, setS] = useState(settings);
  const [upns, setUpns] = useState(settings.allowedUpns.join("\n"));
  const [ack, setAck] = useState(false);
  const [pending, start] = useTransition();
  const set = <K extends keyof SandboxSettings>(k: K, v: SandboxSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const needsAck = s.allowRunc && !settings.allowRunc;

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed");
      }
    });

  return (
    <div className="space-y-6">
      <HealthBanner configured={configured} health={health} error={error} allowRunc={settings.allowRunc} />

      <Card className="space-y-4">
        <h2 className="font-medium">Settings</h2>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm">
          Give people workspaces (bots with the Workspace tool can use them)
          <Switch aria-label="Enable workspaces" checked={s.enabled} onCheckedChange={(v) => set("enabled", v)} />
        </label>
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
              <Textarea aria-label="Allowed people" rows={3} value={upns} onChange={(e) => setUpns(e.target.value)} className="font-mono" />
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
        <div className="flex justify-end">
          <Button
            disabled={pending || (needsAck && !ack)}
            onClick={() =>
              run(
                () =>
                  saveSandboxSettings({
                    enabled: s.enabled,
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
