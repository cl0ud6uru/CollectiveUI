"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { disconnectAllChatGPT, saveChatGPTSettings } from "@/app/admin/actions";
import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ChatGPTSettings } from "@/lib/settings";
import { GroupPicker } from "./group-picker";
import { Badge, Card } from "./ui";

const toLines = (v: string) => v.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean);

export function ChatGPTSettingsCard({
  initial,
  groups,
  connections,
}: {
  initial: ChatGPTSettings;
  groups: { id: string; name: string }[];
  connections: number;
}) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [upns, setUpns] = useState(initial.allowedUpns.join("\n"));
  const [workspaces, setWorkspaces] = useState(initial.allowedWorkspaceIds.join("\n"));
  const [acknowledge, setAcknowledge] = useState(false);
  const [pending, start] = useTransition();
  const needsAck = s.enabled && !initial.acknowledgedAt;
  const set = <K extends keyof ChatGPTSettings>(k: K, v: ChatGPTSettings[K]) => setS((x) => ({ ...x, [k]: v }));

  const run = (fn: () => Promise<unknown>, ok: string) =>
    start(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });

  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="font-medium">Sign in with ChatGPT</h2>
        <Badge tone="amber">unofficial</Badge>
      </div>
      <p className="text-sm text-muted">
        Lets the people you choose connect their own ChatGPT plan (Business, Enterprise, Edu, and optionally personal plans such as Plus) and chat on it
        through ChatGPT model connections you add under Connections. It signs in the way Codex CLI does and uses OpenAI&apos;s private Codex backend, so it may stop working
        without notice, and OpenAI&apos;s sign-in page will say people are authorizing &quot;Codex&quot;. Usage counts against each person&apos;s plan limits,
        not your API keys. Sign-ins are stored encrypted and never reach browsers; check that this fits your OpenAI agreement before turning it on.
      </p>

      <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm">
        Let people connect their ChatGPT plan
        <Switch aria-label="Enable Sign in with ChatGPT" checked={s.enabled} onCheckedChange={(v) => set("enabled", v)} />
      </label>
      {needsAck && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
          I understand this is unofficial, uses people&apos;s own ChatGPT plans, and may stop working.
        </label>
      )}
      {initial.acknowledgedAt && (
        <p className="text-xs text-subtle">
          Turned on by {initial.acknowledgedBy} on {initial.acknowledgedAt.slice(0, 10)}.
        </p>
      )}

      <Field label="Who can connect" hint="Admins can always connect while this is on (to list models for ChatGPT connections).">
        <Select aria-label="Who can connect" value={s.access} onChange={(e) => set("access", e.target.value as ChatGPTSettings["access"])}>
          <option value="selected">Selected groups and people</option>
          <option value="everyone">Everyone</option>
        </Select>
      </Field>
      {s.access === "selected" && (
        <>
          <Field label="Groups">
            <GroupPicker groups={groups} value={s.allowedGroupIds} onChange={(v) => set("allowedGroupIds", v)} />
          </Field>
          <Field label="People" hint="One user principal name (sign-in name) per line.">
            <Textarea aria-label="Allowed people" rows={3} value={upns} onChange={(e) => setUpns(e.target.value)} placeholder="jane.doe@example.com" />
          </Field>
        </>
      )}
      <Field label="Allowed ChatGPT workspaces" hint="Workspace (account) IDs, one per line. Empty allows any Business / Enterprise / Edu workspace.">
        <Textarea aria-label="Allowed ChatGPT workspaces" rows={2} value={workspaces} onChange={(e) => setWorkspaces(e.target.value)} className="font-mono text-xs" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm">
          Allow personal plans (Free, Plus, Pro)
          <Switch aria-label="Allow personal plans" checked={s.allowPersonalPlans} onCheckedChange={(v) => set("allowPersonalPlans", v)} />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm" title="Routines run unattended on their owner's plan">
          Let routines use their owner&apos;s plan
          <Switch aria-label="Let routines use ChatGPT plans" checked={s.allowBackground} onCheckedChange={(v) => set("allowBackground", v)} />
        </label>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <Button
          disabled={pending || (needsAck && !acknowledge)}
          onClick={() =>
            run(
              () =>
                saveChatGPTSettings({
                  enabled: s.enabled,
                  acknowledge,
                  access: s.access,
                  allowedGroupIds: s.allowedGroupIds,
                  allowedUpns: toLines(upns),
                  allowedWorkspaceIds: toLines(workspaces),
                  allowPersonalPlans: s.allowPersonalPlans,
                  allowBackground: s.allowBackground,
                }),
              "Saved",
            )
          }
        >
          Save ChatGPT settings
        </Button>
        <div className="flex items-center gap-3 text-sm text-muted">
          {connections} {connections === 1 ? "person" : "people"} connected
          <Button
            variant="outline"
            disabled={pending || !connections}
            onClick={() => {
              if (!confirm("Disconnect everyone's ChatGPT plan? Their sign-ins are revoked and they'll need to connect again.")) return;
              run(() => disconnectAllChatGPT(), "Everyone was disconnected");
            }}
          >
            Disconnect everyone
          </Button>
        </div>
      </div>
      <p className="text-xs text-subtle">Turning this off stops all use immediately; connections are kept until you disconnect everyone.</p>
    </Card>
  );
}
