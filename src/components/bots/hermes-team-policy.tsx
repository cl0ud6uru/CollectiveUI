"use client";

import { useId } from "react";
import { Field, Select } from "@/components/ui/input";

export type HermesTeamModelPolicy = "admin_provided" | "admin_default_personal_allowed" | "personal_required";
export type HermesTeamPolicyValue = { enabled: boolean; modelPolicy: HermesTeamModelPolicy; maintainerIds: string[]; expectedVersion?: number };
export type HermesTeamModelOption = { value: HermesTeamModelPolicy; available: boolean; reason?: string };

const policies: Record<HermesTeamModelPolicy, { label: string; description: string }> = {
  admin_provided: { label: "Admin-provided model", description: "Everyone uses the model provided by the admin." },
  admin_default_personal_allowed: { label: "Admin-provided default, personal ChatGPT allowed", description: "Members can choose to connect their own ChatGPT account." },
  personal_required: { label: "Personal ChatGPT required", description: "Members must connect ChatGPT before this bot can work. Replies, learning and helper work pause when their connection needs attention." },
};

/** Controlled by the existing editor. Available routes and eligible admins come from the server. */
export function HermesTeamPolicy({ value, onChange, maintainers, modelOptions, disabled = false }: {
  value: HermesTeamPolicyValue;
  onChange: (value: HermesTeamPolicyValue) => void;
  maintainers: { id: string; name: string; disabled?: boolean }[];
  modelOptions: HermesTeamModelOption[];
  disabled?: boolean;
}) {
  const id = useId();
  const option = modelOptions.find((item) => item.value === value.modelPolicy);
  return <fieldset disabled={disabled} className="min-w-0 space-y-4 rounded-xl border border-border p-3" aria-label="Hermes Team Bot configuration">
    <legend className="px-1 text-sm font-medium">Team Bot</legend>
    <label className="flex items-start gap-3 text-sm" htmlFor={`${id}-enabled`}>
      <input id={`${id}-enabled`} type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
      <span>Share a Hermes Team Bot<span className="mt-1 block text-xs text-muted">Uses the audience above. Each person gets private chat history, memory and learned skills. Admins teach a separate working bot and choose what to publish.</span></span>
    </label>
    {value.enabled && <>
      <Field label="Model access" hint={policies[value.modelPolicy].description}>
        <Select aria-label="Team Bot model access" value={value.modelPolicy} onChange={(event) => onChange({ ...value, modelPolicy: event.target.value as HermesTeamModelPolicy })}>
          {(Object.keys(policies) as HermesTeamModelPolicy[]).map((policy) => <option key={policy} value={policy} disabled={!modelOptions.some((item) => item.value === policy && item.available)}>{policies[policy].label}</option>)}
        </Select>
      </Field>
      {(!option?.available || option.reason) && <p role="status" className="text-xs text-muted">{option?.reason ?? "This model route has not been verified. Chat will stay paused until an admin configures a supported connection."}</p>}
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Who can maintain it</legend>
        <p className="text-xs text-muted">Only selected admins can enter Admin mode. Maintainers share the working bot’s skills and native memory. Each maintainer has a separate Admin mode conversation.</p>
        <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
          {maintainers.map((admin) => <label key={admin.id} className="flex items-start gap-3 px-3 py-2 text-sm hover:bg-hover">
            <input type="checkbox" aria-label={`Maintainer: ${admin.name}`} checked={value.maintainerIds.includes(admin.id)} disabled={admin.disabled} onChange={(event) => onChange({ ...value, maintainerIds: event.target.checked ? [...value.maintainerIds, admin.id] : value.maintainerIds.filter((selected) => selected !== admin.id) })} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
            <span className="min-w-0 wrap-anywhere">{admin.name}{admin.disabled && <span className="ml-1 text-xs text-muted">(unavailable)</span>}</span>
          </label>)}
          {!maintainers.length && <p className="px-3 py-2 text-sm text-muted">No eligible admins are available.</p>}
        </div>
      </fieldset>
      <p className="text-xs text-muted">CollectiveUI sign-in and the model connection are separate. Model routes and tool connections must be verified before this bot can use them.</p>
    </>}
  </fieldset>;
}
