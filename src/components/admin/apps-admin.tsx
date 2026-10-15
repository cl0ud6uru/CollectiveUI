"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Plug, Plus, Trash2 } from "lucide-react";
import { deleteApp, saveApp, testAppConnection, type AppInput } from "@/app/admin/actions";
import { migrateAppProviderConnection } from "@/app/admin/provider-actions";
import type { ProviderConnectionView } from "@/lib/llm/catalog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { OPENROUTER_BASE_URL, isOpenRouterBaseUrl, APP_PROVIDERS, CATALOG, endpointLabel, isEnabledKind, isSavedProviderKind, normalizeBaseUrl, savedProviderConfig, SAVED_PROVIDER_LABELS, supportsEmbeddings, type AppProvider, type CredentialsInput } from "@/lib/llm/catalog";
import { AppIcon } from "@/components/app-icon";
import { AvatarPicker } from "@/components/bots/avatar-picker";
import { ModelCatalogPicker } from "./model-catalog-picker";
import { GroupPicker } from "./group-picker";
import { Badge, Table, Td } from "./ui";

/** App as sent to the browser: no secrets, only whether one is stored. */
export type AppRow = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  provider: AppProvider;
  config: Record<string, unknown>;
  baseUrl: string | null;
  hasKey: boolean;
  providerConnectionId?: string | null;
  model: string;
  systemPrompt: string | null;
  temperature: number | null;
  maxTokens: number | null;
  contextWindowTokens?: number | null;
  supportsVision: boolean;
  supportsTools: boolean;
  embeddingModel: string | null;
  isPublic: boolean;
  enabled: boolean;
  sortOrder: number;
  groupIds: string[];
};

type FormState = Omit<AppRow, "id" | "hasKey"> & { id?: string; hasKey: boolean };

const EMPTY: FormState = {
  name: "",
  description: null,
  icon: "",
  provider: "openai-compatible",
  config: {},
  baseUrl: "https://",
  hasKey: false,
  providerConnectionId: null,
  model: "",
  systemPrompt: null,
  temperature: null,
  maxTokens: null,
  contextWindowTokens: null,
  supportsVision: false,
  supportsTools: true,
  embeddingModel: null,
  isPublic: true,
  enabled: true,
  sortOrder: 0,
  groupIds: [],
};

// Keep password managers, autofill and cloud spellcheck away from credential fields.
const secretProps = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
} as const;

function AppDialog({
  app,
  connections,
  groups,
  chatgptEnabled,
  onClose,
}: {
  app: FormState | null;
  connections: ProviderConnectionView[];
  groups: { id: string; name: string }[];
  chatgptEnabled: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [f, setF] = useState<FormState>(app ?? EMPTY);
  const [credentials, setCredentials] = useState<CredentialsInput>({});
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const testInFlight = useRef(false);
  const testRevision = useRef(0);
  const clearTestResult = () => { testRevision.current++; setTestResult(null); };
  const [pending, start] = useTransition();
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => { clearTestResult(); setF((x) => ({ ...x, [k]: v })); };
  const setConfig = (k: string, v: unknown) => { clearTestResult(); setF((x) => ({ ...x, config: { ...x.config, [k]: v } })); };
  const entry = CATALOG[f.provider];
  // ChatGPT plan apps: no credentials, endpoint or sampling settings; each person's own plan is used.
  const personal = entry.credentials === "user";
  // Hermes profiles run their own model and tools: no sampling settings or capability switches.
  const agent = f.provider === "hermes";
  const providers = APP_PROVIDERS.filter((k) => (k === "hermes") === agent && (k !== "chatgpt" || chatgptEnabled || app?.provider === "chatgpt"));

  function switchProvider(kind: AppProvider) {
    const next = CATALOG[kind];
    setF((x) => ({
      ...x,
      provider: kind,
      providerConnectionId: null,
      config: { ...next.defaultConfig },
      baseUrl: kind === "openrouter" ? OPENROUTER_BASE_URL : next.baseUrl.mode === "required" && kind === "openai-compatible" ? "https://" : null,
      maxTokens: x.maxTokens ?? next.defaultMaxTokens ?? null,
      embeddingModel: supportsEmbeddings(kind) ? x.embeddingModel : null,
    }));
    setCredentials({});
    setModels([]);
    clearTestResult();
  }

  const linked = !!f.providerConnectionId;
  const visibleSecrets = (linked ? [] : entry.secrets).filter((s) => !s.when || String(f.config[s.when.key] ?? "") === s.when.value);
  const normalizedUrl = isEnabledKind(f.provider) ? normalizeBaseUrl(f.provider, f.baseUrl) : { ok: true as const };
  const urlError = !normalizedUrl.ok && f.baseUrl !== "https://" ? normalizedUrl.error : null;
  const baseUrlOk = entry.baseUrl.mode !== "required" || (!!f.baseUrl && f.baseUrl !== "https://");
  const openrouter = f.provider === "openrouter" || (f.provider === "openai-compatible" && isOpenRouterBaseUrl(f.baseUrl));
  const missingKey = f.provider === "openrouter" && !linked && !(f.hasKey && app?.provider === "openrouter") && !credentials.apiKey?.trim();
  const selectedConnection = connections.find(c => c.id === f.providerConnectionId);
  const disabledConnection = linked && !selectedConnection?.enabled;
  const retainingConnection = !!f.id && !!selectedConnection && app?.providerConnectionId === selectedConnection.id;
  const fieldsBlocked = urlError || (!baseUrlOk ? "Enter an API base URL first." : missingKey ? "Enter your OpenRouter API key." : null);
  const testBlocked = fieldsBlocked || (disabledConnection ? "Enable the saved provider connection or choose another one to test." : entry.test === "probe" && !f.model.trim() ? `Enter the ${entry.modelLabel.toLowerCase()} first.` : null);
  const canTest = !testBlocked;
  // Like saveApp, allow edits that retain an existing disabled connection, but never attach a different one.
  const saveBlocked = fieldsBlocked || (disabledConnection && !retainingConnection ? "Choose an enabled saved provider connection before saving." : !f.name.trim() ? "Enter a connection name to save." : !f.model.trim() ? "Choose a model or enter its ID to save. Placeholder text is only an example." : null);

  const payload = (): AppInput =>
    ({
      id: f.id,
      name: f.name,
      description: f.description,
      icon: f.icon,
      provider: f.provider,
      config: f.config,
      baseUrl: entry.baseUrl.mode === "none" ? null : f.baseUrl,
      model: f.model,
      systemPrompt: f.systemPrompt,
      temperature: f.temperature,
      maxTokens: f.maxTokens,
      contextWindowTokens: f.contextWindowTokens,
      supportsVision: f.supportsVision,
      supportsTools: f.supportsTools,
      embeddingModel: f.embeddingModel,
      isPublic: f.isPublic,
      enabled: f.enabled,
      sortOrder: f.sortOrder,
      groupIds: f.groupIds,
      providerConnectionId: f.providerConnectionId ?? null,
      credentials,
    }) as AppInput;

  async function test() {
    if (testInFlight.current) return;
    testInFlight.current = true;
    const revision = testRevision.current;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testAppConnection({
        id: f.id,
        provider: f.provider,
        name: f.name,
        baseUrl: entry.baseUrl.mode === "none" ? null : f.baseUrl,
        model: f.model,
        config: f.config,
        providerConnectionId: f.providerConnectionId ?? null,
        credentials,
      });
      if (revision !== testRevision.current) return;
      if (r.ok) {
        setModels(r.models);
        // Hermes serves one model id per profile: fill it in.
        if (agent && r.models.length === 1 && !f.model) set("model", r.models[0]);
        setTestResult({ ok: true, message: r.note ?? `Connected. ${r.models.length} models returned; select a model ID to save.` });
        toast.success(r.models.length ? `Connected — ${r.models.length} model(s)` : `Connected — ${r.note ?? "the model answered"}`);
      } else { setTestResult({ ok: false, message: r.error }); toast.error(`Connection failed: ${r.error}`); }
    } catch (err) {
      if (revision !== testRevision.current) return;
      const message = err instanceof Error ? err.message : "Could not test the connection. Try again.";
      setTestResult({ ok: false, message });
      toast.error(message);
    } finally {
      testInFlight.current = false;
      setTesting(false);
    }
  }

  return (
    <Dialog open={!!app} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={f.id ? `Edit ${f.name}` : agent ? "Add agent backend" : "Add model connection"} className="max-w-2xl">
        <div className="space-y-4">
          <div className="flex gap-3">
            <Field label="Icon">
              <AvatarPicker value={f.icon} onChange={(v) => set("icon", v)} className="h-10 w-10" size={40} reset={{ label: "Default icon", preview: <AppIcon icon="" className="h-10 w-10" /> }} />
            </Field>
            <div className="flex-1">
              <Field label="Name">
                <Input aria-label="Name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={agent ? "Engineering Hermes" : "Team GPT"} />
              </Field>
            </div>
          </div>
          <Field label="Description">
            <Input aria-label="Description" value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} placeholder={agent ? "Shown when choosing a bot backend" : "Shown in the model picker"} />
          </Field>
          {!agent && <Field label="Saved provider connection" hint="Choose a saved company credential to set the API type and endpoint, or enter credentials on this model.">
            <Select aria-label="Saved provider connection" value={f.providerConnectionId ?? ""} onChange={e => {
              const c = connections.find(c => c.id === e.target.value);
              if (c) setF(x => ({ ...x, provider: c.provider, providerConnectionId: c.id, baseUrl: c.baseUrl, embeddingModel: supportsEmbeddings(c.provider) ? x.embeddingModel : null,
                config: savedProviderConfig(c, c.provider === x.provider ? x.config : CATALOG[c.provider].defaultConfig) as Record<string, unknown> }));
              else setF(x => ({ ...x, providerConnectionId: null, baseUrl: x.provider === "openai-compatible" ? "https://" : null, config: { ...CATALOG[x.provider].defaultConfig } }));
              setCredentials({}); setModels([]); clearTestResult();
            }}>
              <option value="">Enter credentials on this model</option>
              {connections.map(c => <option key={c.id} value={c.id} disabled={!c.enabled && (!app?.id || c.id !== app.providerConnectionId)}>{c.name} · {SAVED_PROVIDER_LABELS[c.provider]}{!c.enabled ? " (disabled)" : ""}</option>)}
            </Select>
            {linked && <Button variant="outline" onClick={test} disabled={testing || !canTest}>Test saved connection</Button>}
            {linked && urlError && <p role="alert" className="text-sm text-danger">{urlError} This saved destination is locked. Create a separate provider connection with the correct API type and base URL, then select it here. For OpenRouter, choose OpenRouter and use {OPENROUTER_BASE_URL}.</p>}
            {linked && disabledConnection && <p role="status" className="text-sm text-muted">{retainingConnection ? "This saved provider connection is disabled, so testing and model use are unavailable. You can still save changes while retaining this connection." : "This saved provider connection is disabled. Choose an enabled connection before saving or testing."}</p>}
            {!linked && isSavedProviderKind(f.provider) && f.id && f.hasKey && <Button variant="outline" disabled={pending || !!urlError} onClick={() => {
              const name = prompt("Name for this model's new reusable connection. Only this model will be migrated; its API type, endpoint, project and audience are preserved. Service bots whose publication is current stay published; bots that already need review still do.", `${f.name} provider`);
              if (!name?.trim()) return;
              start(async () => { try { await migrateAppProviderConnection(f.id!, name); onClose(); router.refresh(); toast.success("Credential migrated; select it on other models to reuse it"); } catch { toast.error("Could not migrate this credential. Check the stored model and administrator access."); } });
            }}>Migrate stored credential to a named connection</Button>}
          </Field>}
          <Field label={agent ? "Agent backend" : "Provider API type"} hint={linked ? "Set by the saved connection. Choose another saved connection or model-specific credentials to change it." : entry.description}>
            <Select disabled={linked} aria-label={agent ? "Agent backend" : "Provider API type"} value={f.provider} onChange={(e) => switchProvider(e.target.value as AppProvider)}>
              {providers.map((k) => (
                <option key={k} value={k}>
                  {CATALOG[k].label}
                </option>
              ))}
            </Select>
          </Field>

          {agent && <p className="rounded-xl border border-border p-3 text-sm text-muted">Bot-only. This connection never appears in New Chat or default model settings. Saving a new manual backend also creates its bot. For isolated per-user runtimes, use Admin → Managed Hermes.</p>}
          {entry.baseUrl.mode !== "none" && (
            <Field label="Base URL" hint={urlError ?? entry.baseUrl.hint}>
              <Input disabled={linked} aria-invalid={!!urlError} aria-label="Base URL" value={f.baseUrl ?? ""} onChange={(e) => set("baseUrl", e.target.value || null)} placeholder={entry.baseUrl.placeholder} />
            </Field>
          )}

          {entry.config.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {entry.config.map((c) =>
                c.type === "switch" ? (
                  <label key={c.key} className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-sm" title={c.hint}>
                    {c.label}
                    <Switch checked={!!f.config[c.key]} onCheckedChange={(v) => setConfig(c.key, v)} />
                  </label>
                ) : c.type === "select" ? (
                  <Field key={c.key} label={c.label} hint={c.hint}>
                    <Select aria-label={c.label} value={String(f.config[c.key] ?? c.options[0].value)} onChange={(e) => setConfig(c.key, e.target.value)}>
                      {c.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : (
                  <Field key={c.key} label={c.label} hint={c.hint}>
                    <Input
                      disabled={linked && (c.key === "organization" || c.key === "project")}
                      aria-label={c.label}
                      value={String(f.config[c.key] ?? "")}
                      onChange={(e) => setConfig(c.key, e.target.value || undefined)}
                      placeholder={c.placeholder}
                    />
                  </Field>
                ),
              )}
            </div>
          )}

          {personal && (
            <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              <p>
                <span className="font-medium">Sign in with ChatGPT.</span> Each person connects their own account in Settings → Connected
                accounts; usage counts against their subscription allowance through OpenAI&apos;s supported token sharing Responses API.
              </p>
              <Button variant="outline" onClick={test} disabled={testing}>
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} List my plan&apos;s models
              </Button>
            </div>
          )}

          {visibleSecrets.map((s, i) => (
            <Field
              key={s.key}
              label={s.label}
              hint={i === 0 ? (f.hasKey ? "Credentials are stored (encrypted). Leave blank to keep them." : f.provider === "openai-compatible" ? "Optional" : undefined) : undefined}
            >
              <div className="flex gap-2">
                {s.multiline ? (
                  <Textarea
                    aria-label={s.label}
                    rows={5}
                    value={credentials[s.key] ?? ""}
                    onChange={(e) => { clearTestResult(); setCredentials((c) => ({ ...c, [s.key]: e.target.value })); }}
                    placeholder={f.hasKey ? "••••••••" : s.placeholder}
                    className="font-mono text-xs"
                    {...secretProps}
                  />
                ) : (
                  <Input
                    aria-label={s.label}
                    type="password"
                    value={credentials[s.key] ?? ""}
                    onChange={(e) => { clearTestResult(); setCredentials((c) => ({ ...c, [s.key]: e.target.value })); }}
                    placeholder={f.hasKey ? "••••••••" : s.placeholder}
                    {...secretProps}
                  />
                )}
                {i === 0 && (
                  <Button variant="outline" onClick={test} disabled={testing || !canTest} title={testBlocked ?? undefined}>
                    {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Test
                  </Button>
                )}
              </div>
            </Field>
          ))}

          {testResult && <p role={testResult.ok ? "status" : "alert"} className={`text-sm ${testResult.ok ? "text-muted" : "text-danger"}`}>{testResult.message}</p>}
          {f.provider === "openrouter" && <p className="text-xs text-muted">Test checks the API key without generating text. Selecting a model and saving do not make a generation request.</p>}
          {testBlocked && !urlError && !disabledConnection && <p className="text-sm text-danger">{testBlocked}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            {openrouter ? <ModelCatalogPicker value={f.model} onChange={(id, model) => setF(x => ({ ...x, model: id, ...(model ? { supportsTools: model.supportsTools, supportsVision: model.supportsVision } : {}) }))} /> : <Field label={agent ? "Profile model route" : entry.modelLabel} hint={agent ? "The route served by this Hermes profile, not an ordinary New Chat model." : "A provider may offer many models. This connection uses the model or deployment selected here."}>
              <Input aria-label={agent ? "Profile model route" : entry.modelLabel} list="model-list" value={f.model} onChange={(e) => set("model", e.target.value)} placeholder={entry.modelPlaceholder} />
              <datalist id="model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>}
            {supportsEmbeddings(f.provider) && !personal && (
              <Field label="Embedding model" hint="Optional, for memory & knowledge search">
                <Input aria-label="Embedding model" list="model-list" value={f.embeddingModel ?? ""} onChange={(e) => set("embeddingModel", e.target.value || null)} />
              </Field>
            )}
            {!personal && !agent && (
            <Field label="Temperature">
              <Input
                aria-label="Temperature"
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={f.temperature ?? ""}
                onChange={(e) => set("temperature", e.target.value === "" ? null : Number(e.target.value))}
              />
            </Field>
            )}
            {!personal && !agent && (
            <Field label="Max output tokens">
              <Input
                aria-label="Max output tokens"
                type="number"
                value={f.maxTokens ?? ""}
                onChange={(e) => set("maxTokens", e.target.value === "" ? null : Number(e.target.value))}
              />
            </Field>
            )}
            {!agent && (
              <Field label="Model context window" hint="Optional. Input is conservatively budgeted below this size; default is 16,384 tokens. Max output tokens are reserved separately.">
                <Input
                  aria-label="Model context window"
                  type="number"
                  min={4096}
                  max={2_000_000}
                  value={f.contextWindowTokens ?? ""}
                  onChange={(e) => set("contextWindowTokens", e.target.value === "" ? null : Number(e.target.value))}
                />
              </Field>
            )}
          </div>
          <Field label="System prompt">
            <Textarea aria-label="System prompt" rows={4} value={f.systemPrompt ?? ""} onChange={(e) => set("systemPrompt", e.target.value || null)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ...(agent
                  ? []
                  : ([
                      ["supportsTools", "Supports tool calling (required for bots)"],
                      ["supportsVision", "Supports images"],
                    ] as const)),
                ["enabled", "Enabled"],
                ["isPublic", agent ? "Available to everyone building bots" : "Available to everyone"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center justify-between rounded-xl border border-border px-3 py-2 text-sm">
                {label}
                <Switch checked={!!f[k]} onCheckedChange={(v) => set(k, v)} />
              </label>
            ))}
          </div>
          {!f.isPublic && (
            <Field label="Groups with access">
              <GroupPicker groups={groups} value={f.groupIds} onChange={(v) => set("groupIds", v)} />
            </Field>
          )}
          <Field label="Sort order">
            <Input aria-label="Sort order" type="number" value={f.sortOrder} onChange={(e) => set("sortOrder", Number(e.target.value))} className="w-28" />
          </Field>
          {saveBlocked && <p role="status" className="text-sm text-danger">{saveBlocked}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={pending || !!saveBlocked}
              onClick={() =>
                start(async () => {
                  try {
                    const saved = await saveApp(payload());
                    toast.success(saved.botId ? "Agent backend saved — its bot is under Bots" : "Connection saved");
                    onClose();
                    router.refresh();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Save failed");
                  }
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AppsAdmin({ apps, groups, chatgptEnabled, connections = [] }: { connections?: ProviderConnectionView[]; apps: AppRow[]; groups: { id: string; name: string }[]; chatgptEnabled: boolean }) {
  const router = useRouter();
  const [edit, setEdit] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const deleteInFlight = useRef(false);

  async function remove(app: AppRow) {
    if (deleteInFlight.current || !confirm(`Delete ${app.name}? Existing chats keep their history.`)) return;
    deleteInFlight.current = true;
    setDeleting(app.id);
    try {
      await deleteApp(app.id);
      toast.success("Connection deleted");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete connection. Try again.");
    } finally {
      deleteInFlight.current = false;
      setDeleting(null);
    }
  }
  return (
    <div>
      {([false, true] as const).map((agent) => {
        const rows = apps.filter((a) => (a.provider === "hermes") === agent);
        return <section key={String(agent)} aria-labelledby={agent ? "agent-backends-heading" : "models-heading"} className="mb-8">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-2xl">
              <h2 id={agent ? "agent-backends-heading" : "models-heading"} className="text-lg font-semibold">{agent ? "Agent backends" : "Models"}</h2>
              <p className="mt-1 text-sm text-muted">{agent ? "Hermes runtimes are used only through bots. Manual connections select a profile; managed runtimes create private per-user profiles." : "Model connections for New Chat and native bots. Each connection selects a provider model or deployment; a provider can offer many models."}</p>
              {agent && <Link href="/admin/hermes" className="mt-2 inline-block text-sm underline">Manage per-user Hermes runtimes</Link>}
            </div>
            <Button onClick={() => setEdit(agent ? { ...EMPTY, provider: "hermes", config: { ...CATALOG.hermes.defaultConfig }, baseUrl: null } : EMPTY)}>
              <Plus className="h-4 w-4" /> {agent ? "Add agent backend" : "Add model connection"}
            </Button>
          </div>
          <Table head={["", "Connection", agent ? "Backend" : "Provider", "Endpoint", agent ? "Profile route" : "Selected model", "Capabilities", "Access", ""]}>
            {rows.map((a) => (
              <tr key={a.id} className="hover:bg-hover/50">
                <Td><AppIcon icon={a.icon} /></Td>
                <Td>
                  <button type="button" onClick={() => setEdit(a)} disabled={deleting === a.id} className="text-left font-medium underline-offset-4 hover:underline" aria-label={`Edit ${a.name}`}>{a.name}</button>
                  {!a.enabled && <Badge tone="red">disabled</Badge>}
                </Td>
                <Td><Badge>{CATALOG[a.provider].label}</Badge></Td>
                <Td className="max-w-[240px] truncate font-mono text-xs text-muted">{endpointLabel(a.provider, a.baseUrl, a.config)}</Td>
                <Td className="font-mono text-xs">{a.model}</Td>
                <Td className="space-x-1">
                  {agent ? <Badge>bot-only</Badge> : <>
                    {a.supportsTools && <Badge tone="blue">tools</Badge>}
                    {a.supportsVision && <Badge tone="blue">vision</Badge>}
                    {a.embeddingModel && <Badge tone="blue">embeddings</Badge>}
                  </>}
                </Td>
                <Td>{a.isPublic ? <Badge tone="green">everyone</Badge> : <Badge tone="amber">{a.groupIds.length} group(s)</Badge>}</Td>
                <Td>
                  <button type="button" onClick={() => remove(a)} disabled={deleting !== null} aria-busy={deleting === a.id} className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-danger disabled:opacity-50" aria-label={`Delete ${a.name}`}>
                    {deleting === a.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  </button>
                </Td>
              </tr>
            ))}
            {!rows.length && <tr><Td colSpan={8} className="py-8 text-center text-muted">{agent ? "No manual agent backends. Add a Hermes connection or manage per-user runtimes above." : "No model connections. Add a provider and select a model for New Chat and native bots."}</Td></tr>}
          </Table>
        </section>;
      })}
      <AppDialog key={edit?.id ?? (edit ? `new-${edit.provider}` : "none")} app={edit} connections={connections} groups={groups} chatgptEnabled={chatgptEnabled} onClose={() => setEdit(null)} />
    </div>
  );
}
