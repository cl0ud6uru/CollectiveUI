"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveProviderConnection, deleteProviderConnection, type ProviderConnectionInput } from "@/app/admin/provider-actions";
import { normalizeBaseUrl, SAVED_PROVIDER_KINDS, SAVED_PROVIDER_LABELS, type ProviderConnectionView, type SavedProviderKind } from "@/lib/llm/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

export type ProviderConnectionRow = ProviderConnectionView & { creatorName: string | null; models: { id: string; name: string }[] };

function ConnectionEditor({ connection, onClose }: { connection: ProviderConnectionRow | null; onClose: () => void }) {
  const router = useRouter();
  const [form, setForm] = useState<ProviderConnectionInput>(() => ({ id: connection?.id, provider: connection?.provider ?? "openai", name: connection?.name ?? "", baseUrl: connection?.baseUrl ?? null,
    organization: connection?.organization ?? null, project: connection?.project ?? null, enabled: connection?.enabled ?? true, apiKey: "" }));
  const [pending, start] = useTransition();
  const set = (key: keyof ProviderConnectionInput, value: string | boolean) => setForm(x => ({ ...x, [key]: value }));
  const provider = form.provider ?? "openai";
  const normalized = normalizeBaseUrl(provider, form.baseUrl);
  const urlError = !normalized.ok ? normalized.error : null;
  return <Dialog open onOpenChange={open => !open && !pending && onClose()}>
    <DialogContent title={connection ? "Edit saved provider connection" : "Save provider connection"} className="max-w-xl">
      <div className="space-y-4">
        <Field label="Connection name"><Input aria-label="Connection name" value={form.name} onChange={e => set("name", e.target.value)} placeholder="Engineering OpenAI project" /></Field>
        <Field label="Provider API type" hint="API type, endpoint and billing selectors cannot be changed after saving. Create another connection for another destination.">
          <Select aria-label="Provider API type" value={provider} disabled={!!connection} onChange={e => setForm(x => ({ ...x, provider: e.target.value as SavedProviderKind, baseUrl: null, organization: null, project: null, apiKey: "" }))}>
            {SAVED_PROVIDER_KINDS.map(kind => <option key={kind} value={kind}>{SAVED_PROVIDER_LABELS[kind]}</option>)}
          </Select>
        </Field>
        <Field label="API base URL" hint={urlError ?? (provider === "openai-compatible" ? "Required API base URL, for example https://provider.example/v1. The application adds /chat/completions and /models." : "Leave blank for OpenAI. Enter a base URL without /responses, /chat/completions or /models.")}>
          <Input aria-label="Provider endpoint" aria-invalid={!!urlError} value={form.baseUrl ?? ""} onChange={e => set("baseUrl", e.target.value)} disabled={!!connection} placeholder={provider === "openai" ? "https://api.openai.com/v1 (default)" : "https://provider.example/v1"} />
        </Field>
        {provider === "openai" && <>
        <Field label="Organization ID"><Input aria-label="Provider organization" value={form.organization ?? ""} onChange={e => set("organization", e.target.value)} disabled={!!connection} /></Field>
        <Field label="Project ID"><Input aria-label="Provider project" value={form.project ?? ""} onChange={e => set("project", e.target.value)} disabled={!!connection} /></Field>
        </>}
        <Field label={connection ? "Replace API key" : "API key"} hint={connection ? "Leave blank to keep the encrypted credential. A replacement is used by every dependent model on its next turn or job." : "Encrypted on the server. The key is never returned to this form."}>
          <Input aria-label="Provider API key" type="password" value={form.apiKey ?? ""} onChange={e => set("apiKey", e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-1p-ignore data-lpignore="true" />
        </Field>
        <label className="flex items-center justify-between gap-2 text-sm">Enabled<Switch checked={form.enabled} onCheckedChange={value => set("enabled", value)} /></label>
        <p className="text-sm text-muted">Disabling stops new turns and jobs, including embeddings and background work. Turns and jobs already in progress may finish. Re-enabling restores use without changing model audiences.</p>
        {connection && <p className="text-sm" aria-label="Affected models">Affected models: {connection.models.map(m => m.name).join(", ") || "None"}.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={onClose}>Cancel</Button>
          <Button disabled={pending || (!connection && !!urlError) || !form.name.trim() || (!connection && !form.apiKey?.trim())} onClick={() => {
            if (connection && (form.apiKey?.trim() || form.enabled !== connection.enabled) && !confirm(`Apply this change to ${connection.models.length} model(s): ${connection.models.map(m => m.name).join(", ") || "none"}? Turns and jobs already in progress may finish.`)) return;
            start(async () => {
              try { await saveProviderConnection(form); setForm(x => ({ ...x, apiKey: "" })); onClose(); router.refresh(); toast.success("Provider connection saved"); }
              catch { toast.error("Could not save the provider connection. Check the fields and your administrator access."); }
            });
          }}>Save provider connection</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}

export function ProviderConnectionsAdmin({ connections }: { connections: ProviderConnectionRow[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<ProviderConnectionRow | "new" | null>(null);
  return <section className="mb-8 space-y-4" aria-labelledby="saved-providers-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="saved-providers-heading" className="text-lg font-semibold">Saved provider credentials</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">Save named OpenAI Responses or OpenAI-compatible Chat Completions credentials for reuse across models. Choose them in Add model connection → Saved provider connection. Only administrators manage credentials; model audiences remain separate. Personal ChatGPT plans and Hermes backends keep their own authentication.</p></div>
      <Button onClick={() => setEdit("new")}>Add provider connection</Button>
    </div>
    {connections.map(c => <div key={c.id} className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1"><button className="break-words font-medium underline" onClick={() => setEdit(c)}>{c.name}</button>{!c.enabled && <span className="ml-2 text-sm text-danger">Disabled</span>}
          <p className="break-words text-xs text-muted">{SAVED_PROVIDER_LABELS[c.provider]} · Created by {c.creatorName ?? "a former administrator"} · {c.baseUrl ?? "OpenAI default endpoint"}{c.provider === "openai" && <> · Organization: {c.organization ?? "key default"} · Project: {c.project ?? "key default"}</>}</p></div>
        <Button variant="outline" disabled={c.models.length > 0} title={c.models.length ? "Reassign or delete dependent models first" : undefined} onClick={async () => {
          if (!confirm(`Delete provider connection ${c.name}?`)) return;
          try { await deleteProviderConnection(c.id); router.refresh(); } catch { toast.error("Could not delete. Check dependent models and administrator access."); }
        }}>Delete</Button>
      </div>
      <p className="mt-2 text-sm">Used by: {c.models.map(m => m.name).join(", ") || "No models yet"}</p>
    </div>)}
    {!connections.length && <p className="text-sm text-muted">No reusable credentials yet. Add one here, or migrate an existing OpenAI or OpenAI-compatible model using its edit dialog.</p>}
    {edit && <ConnectionEditor key={edit === "new" ? "new" : edit.id} connection={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
  </section>;
}
