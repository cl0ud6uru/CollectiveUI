"use client";
import type { CodexPolicy } from '@/lib/codex/config';
import { Field, Input, Select } from '@/components/ui/input';

export function CodexHarnessSettings({ value, onChange, status }: { value: CodexPolicy; onChange: (value: CodexPolicy) => void;
  status?: { api: string; chatgpt_subscription: string } }) {
  return (<div className="space-y-4 rounded-xl border border-border p-4">
    <p className="text-sm">Each caller uses their own isolated Codex runtime. Sharing this bot does not share your account. No company or bot-owner credential fallback.</p>
    <Field label="Codex funding"><Select aria-label="Codex funding" value={value.funding} onChange={e => onChange({ ...value, funding: e.target.value as "api" | "chatgpt_subscription" })}>
      <option value="api">My API-funded runtime</option><option value="chatgpt_subscription">My authorized ChatGPT subscription runtime</option>
    </Select></Field>
    <p role="status" className="text-sm text-muted">{status?.[value.funding] ?? "Runtime assignment has not been checked."}</p>
    <Field label="Codex model" hint="Must be offered by each caller’s runtime. No automatic replacement."><Input aria-label="Codex model" value={value.model} onChange={e => onChange({ ...value, model: e.target.value })} /></Field>
    <Field label="Reasoning effort"><Select aria-label="Reasoning effort" value={value.effort} onChange={e => onChange({ ...value, effort: e.target.value as CodexPolicy['effort'] })}>
      {(["low", "medium", "high", "xhigh"] as const).map(e => <option key={e} value={e}>{e}</option>)}
    </Select></Field>
    <p className="text-xs text-muted">Personal subscription runtimes execute commands and edit files in your private workspace, with native history retained across turns. Connect once in Settings → Connected accounts. Standard speed. Attachments, background work and permission expansion are unavailable. Legacy API runtime assignments remain text-only.</p>
  </div>);
}
