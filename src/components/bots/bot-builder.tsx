"use client";

import { UserPicker, type UserOption } from "@/components/user-picker";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FileText, Loader2, Sparkles, Upload, Wand2, X } from "lucide-react";
import {
  addKnowledgeFile,
  createBot,
  draftBotFromDescription,
  removeKnowledgeFile,
  updateBot,
  type BotInput,
} from "@/app/(chat)/bots/actions";
import { Chat } from "@/components/chat/chat";
import type { TargetOption } from "@/components/chat/types";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import type { ApprovalMode } from "@/db/schema";
import type { ToolOption } from "@/lib/bots/builder-data";
import { cn } from "@/lib/utils";
import { SEARCH_COST_NOTICE } from "@/lib/native-search-policy";
import { BuilderAvatar } from "./builder-avatar";
import { BotDeleteButton } from "./bot-delete-button";
import { BotPetSettings } from "@/components/pets/bot-pet";
import { PetChoices } from "@/components/pets/pet-choices";
import type { CatalogPet } from "@/lib/pets/shared";
import { BotAvatar, randomBlob } from "./bot-avatar";
import { createPersonalHermesBot } from "@/app/(chat)/settings/hermes-actions";
import { ServiceGrantEditor } from "./service-grant-editor";
import type { ServiceGrantInput } from "@/lib/bots/service-policy";
import { HermesTeamPolicy, type HermesTeamPolicyValue, type HermesTeamModelOption } from "./hermes-team-policy";

type Option = { id: string; name: string };
type ToolChoice = BotInput["tools"][number];

const APPROVAL_LABELS: Record<ApprovalMode, string> = {
  auto: "Runs automatically",
  ask: "Ask me first",
  smart: "Ask unless read-only",
};

/** An MCP server's tools on this bot: which ones it gets and, per tool, how approval works. */
function McpToolChoices({ option, choice, onChange, service = false }: { option: ToolOption; choice: ToolChoice; onChange: (c: ToolChoice) => void; service?: boolean }) {
  const [open, setOpen] = useState(!!choice.config);
  const all = option.mcpTools ?? [];
  if (!all.length) return <p className="px-3 pb-2.5 pl-10 text-xs text-muted">No reviewed tools are available. Ask an admin to test this connector and review its enabled tools.</p>;
  const picked = new Set(choice.config?.tools ?? all.map((t) => t.name));
  const approvals = choice.config?.approvals ?? {};
  const update = (tools: string[] | undefined, next: Record<string, ApprovalMode>) =>
    onChange({ ...choice, config: { ...(tools ? { tools } : {}), ...(Object.keys(next).length ? { approvals: next } : {}) } });
  const toolsArg = (s: Set<string>) => (s.size === all.length ? undefined : all.filter((t) => s.has(t.name)).map((t) => t.name));
  return (
    <div className="px-3 pb-2.5 pl-10">
      <button type="button" className="text-xs text-muted underline" onClick={() => setOpen(!open)}>
        {open ? "Hide tools" : `Choose tools (${picked.size} of ${all.length})`}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {!option.trusted && (
            <p className="text-xs text-muted">
              This server isn&apos;t marked trusted, so &quot;Ask unless read-only&quot; asks before every tool.
            </p>
          )}
          {all.map((t) => (
            <div key={t.name} className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Use ${t.name}`}
                checked={picked.has(t.name)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(t.name);
                  else next.delete(t.name);
                  update(toolsArg(next), approvals);
                }}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <div className="min-w-0 flex-1">
                <span className="font-mono text-xs">{t.name}</span>
                {t.readOnly && <span className="ml-1.5 text-[10px] text-green-700 dark:text-green-300">read-only</span>}
                {t.destructive && <span className="ml-1.5 text-[10px] text-danger">destructive</span>}
                {t.description && <div className="truncate text-[11px] text-muted">{t.description}</div>}
              </div>
              {picked.has(t.name) && !service && (
                <Select
                  value={approvals[t.name] ?? ""}
                  aria-label={`${t.name} approval`}
                  onChange={(e) => {
                    const next = { ...approvals };
                    if (e.target.value) next[t.name] = e.target.value as ApprovalMode;
                    else delete next[t.name];
                    update(toolsArg(picked), next);
                  }}
                  className="h-7 w-auto shrink-0 gap-1 px-2 text-[11px]"
                >
                  <option value="">Same as server</option>
                  {(Object.keys(APPROVAL_LABELS) as ApprovalMode[]).map((m) => (
                    <option key={m} value={m}>
                      {APPROVAL_LABELS[m]}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BotBuilder({
  botId,
  initial,
  apps,
  groups,
  users = [],
  tools,
  delegates,
  delegators = [],
  knowledge,
  previewTarget,
  newChatId,
  isAdmin = false,
  revision,
  publishedRevision, publicationStatus,
  serviceGrants = [],
  petCatalog = [],
  personalHermesAvailable = false,
  teamConfig,
  teamMaintainers = [],
  teamModelOptions = [],
}: {
  botId?: string;
  initial: BotInput;
  apps: (Option & { supportsTools: boolean; agentServer?: boolean; managed?: boolean; local?: boolean; docker?: boolean; model?: string; nativeSearchReason?: string | null })[];
  groups: Option[];
  users?: UserOption[];
  tools: ToolOption[];
  delegates: (Option & { avatar: string | null })[];
  delegators?: (Option & { avatar: string | null })[];
  knowledge: { attachmentId: string; filename: string; chunks: number }[];
  previewTarget?: TargetOption;
  newChatId: string;
  isAdmin?: boolean;
  revision?: number;
  publishedRevision?: number | null; publicationStatus?: { published: boolean; reason: string };
  serviceGrants?: ServiceGrantInput[];
  petCatalog?: CatalogPet[];
  personalHermesAvailable?: boolean;
  /** Offered only by the server when this bot supports Team Bot configuration. */
  teamConfig?: HermesTeamPolicyValue;
  teamMaintainers?: { id: string; name: string; disabled?: boolean }[];
  teamModelOptions?: HermesTeamModelOption[];
}) {
  const router = useRouter();
  const [form, setForm] = useState<BotInput>(initial);
  const [team, setTeam] = useState(teamConfig);
  const [tab, setTab] = useState<"create" | "configure">(botId ? "configure" : "create");
  const [pending, start] = useTransition();
  const [idea, setIdea] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [uploading, setUploading] = useState(false);
  const set = <K extends keyof BotInput>(k: K, v: BotInput[K]) => setForm((f) => ({ ...f, [k]: v }));
  const app = apps.find((a) => a.id === form.appId);
  const [engineChoice, setEngineChoice] = useState<"native" | "hermes">(() => apps.find((a) => a.id === initial.appId)?.agentServer ? "hermes" : "native");
  const engine = form.appId === "personal-hermes" ? "hermes" : app ? (app.agentServer ? "hermes" : "native") : engineChoice;
  const connections = apps.filter((a) => !!a.agentServer === (engine === "hermes"));
  const personalNew = !botId && form.appId === "personal-hermes";
  const docker = personalNew || apps.find(a => a.id === initial.appId)?.docker === true;
  const local = apps.find((a) => a.id === initial.appId)?.local === true;
  const managed = personalNew || apps.find((a) => a.id === initial.appId)?.managed === true;
  const service = form.executionMode === "service";
  const toolOn = (key: string) => form.tools.find((t) => t.key === key);

  function toggleTool(t: ToolOption, on: boolean) {
    set("tools", on ? [...form.tools, { key: t.key, approval: t.defaultApproval }] : form.tools.filter((x) => x.key !== t.key));
  }

  function save() {
    start(async () => {
      try {
        if (botId) {
          await updateBot(botId, form);
          await saveTeamSettings(botId);
          toast.success("Bot updated");
          router.refresh();
        } else {
          let id: string;
          if (personalNew) {
            const storageKey = "collective-hermes-create";
            const saved = sessionStorage.getItem(storageKey);
            const previous = saved ? JSON.parse(saved) as { name: string; requestId: string } : null;
            const request = previous?.name === form.name ? previous : { name: form.name, requestId: crypto.randomUUID() };
            sessionStorage.setItem(storageKey, JSON.stringify(request));
            ({ id } = await createPersonalHermesBot(request));
            sessionStorage.removeItem(storageKey);
          } else ({ id } = await createBot(form));
          await saveTeamSettings(id);
          toast.success("Bot created");
          router.push(`/bots/${id}/edit`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  async function saveTeamSettings(id: string) {
    if (!team || !isAdmin || engine !== "hermes" || JSON.stringify(team) === JSON.stringify(teamConfig)) return;
    const response = await fetch(`/api/bots/${encodeURIComponent(id)}/team`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(team) });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(`Bot configuration saved, but Team Bot settings need attention: ${data.error ?? "save was not confirmed"}`);
    }
  }

  async function draft() {
    if (!idea.trim() || drafting) return;
    setDrafting(true);
    setDraftError("");
    try {
      const result = await draftBotFromDescription(idea);
      // The description and form stay as they were, so fixing the cause and retrying needs no retyping.
      if (!result.ok) {
        setDraftError(result.error);
        return;
      }
      const d = result.draft;
      setForm((f) => ({
        ...f,
        name: d.name,
        avatar: randomBlob(),
        label: d.label,
        description: d.description,
        instructions: d.instructions,
        boundaries: d.boundaries,
        starters: d.starters,
        tools: d.tools.map((k) => ({ key: k, approval: tools.find((t) => t.key === k)?.defaultApproval ?? "auto" })),
      }));
      setTab("configure");
      toast.success("Draft ready — review and save");
    } catch {
      // Only transport failures land here (offline, server restarted); the action returns its own errors.
      setDraftError("Couldn't reach the server to draft your bot. Check your connection and try again.");
    } finally {
      setDrafting(false);
    }
  }

  async function uploadKnowledge(files: FileList) {
    if (!botId) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/files", { method: "POST", body: fd });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Upload failed");
        const r = await addKnowledgeFile(botId, body.id);
        toast.success(`${file.name}: ${r.chunks} chunks${r.embedded ? "" : " (keyword search only)"}`);
      }
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-2">
      <div className="min-h-0 overflow-y-auto border-r border-border">
        <div className="mx-auto max-w-2xl px-5 py-4">
          <div className="mb-6 flex justify-center">
            <div className="flex rounded-full bg-surface-2 p-1 text-sm">
              {(["create", "configure"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn("rounded-full px-4 py-1.5 capitalize", tab === t ? "bg-bg font-medium shadow-sm" : "text-muted")}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {tab === "create" ? (
            <div className="space-y-4">
              <p className="text-sm text-muted">
                Describe the teammate you want — its job, who it helps, what it should never do. I&apos;ll draft the configuration for you.
              </p>
              <Textarea
                rows={6}
                value={idea}
                aria-label="Describe your bot"
                aria-describedby={draftError ? "bot-draft-error" : undefined}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="e.g. A bot that triages our support inbox every morning, drafts replies for common questions, and flags anything urgent to me."
              />
              {draftError && <p id="bot-draft-error" role="alert" className="text-sm text-danger">{draftError}</p>}
              <Button onClick={draft} disabled={drafting || !idea.trim()}>
                {drafting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {drafting ? "Drafting…" : draftError ? "Try again" : "Draft my bot"}
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              {!personalNew && <>
              <div className="flex justify-center">
                <BuilderAvatar botId={botId} avatar={form.avatar} onAvatarChange={(v) => set("avatar", v)} initialPet={form.initialPet} catalog={petCatalog} />
              </div>
              <section className="space-y-3 rounded-xl border border-border p-3" aria-label="Pet avatar configuration">
                <h2 className="text-sm font-medium">Pet avatar</h2>
                {botId ? <><p className="text-xs text-muted">Pet changes save separately from the bot configuration. Changing a pet does not revoke service permissions. Save any audience changes before configuring its pet.</p><BotPetSettings botId={botId} botName={initial.name} botAvatar={initial.avatar} editor /></> : <>
                  <p className="text-xs text-muted">{form.visibility !== "private" || service ? "This pet will be shared with everyone who can use the bot. Only its authorized owner or an admin can change it; service bots are admin only." : "This will be your personal avatar for this private bot."} The selection is saved only when you create the bot. Uploaded art must first be approved in the shared catalog.</p>
                  <PetChoices value={form.initialPet ?? { appearance: "off", catalogId: null }} onChange={(choice) => set("initialPet", choice)} catalog={petCatalog} avatar={form.avatar} original disabled={pending} />
                </>}
              </section>
              </>}
              {local && !docker && <p className="text-sm text-muted">This private Local Hermes bot is paired to an existing native profile. Engine binding and persona are managed in Admin → Hermes engines and in Hermes itself.</p>}
              {personalNew && <p className="text-sm text-muted">Creates a private native profile with the Moss companion. You can edit bot details and appearance after creation.</p>}
              {docker && !personalNew && <p className="text-sm text-muted">Private native profile in your own Hermes runtime. Skills, memory and persona stay in Hermes. <a className="underline" href="/settings?tab=connected-accounts">Enable or check your runtime in Settings.</a></p>}
              {managed && !local && !docker && <p className="text-sm text-muted">Managed Hermes definitions preserve existing profiles and memory. The name, description, instructions, boundaries and agent backend are fixed here. Create a new definition in Admin → Managed Hermes for changes; visibility, starters and appearance can still be edited.</p>}
              <Field label="Name">
                <Input disabled={managed && !docker && !local} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Name your bot" />
              </Field>
              {!personalNew && <>
              <Field label="Label (optional)" hint="A short role tag shown next to the name, e.g. Chief of Staff or Inbox triage.">
                <Input value={form.label ?? ""} onChange={(e) => set("label", e.target.value)} maxLength={40} />
              </Field>
              <Field
                label="Job"
                hint="Describe the role in operational terms — the outcome it owns, its sources and what needs approval. E.g. “Own the weekly account-health review… Never contact a customer without approval.” Avoid vague jobs like “General helper”."
              >
                <Textarea rows={2} disabled={managed && !docker && !local} value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} />
              </Field>
              <Field label="Instructions" hint="How it should work: steps, tone, formats, what good looks like.">
                <Textarea rows={8} disabled={managed} value={form.instructions ?? ""} onChange={(e) => set("instructions", e.target.value)} />
              </Field>
              <Field label="Boundaries" hint="Doors that stay locked: things it must never do.">
                <Textarea rows={3} disabled={managed} value={form.boundaries ?? ""} onChange={(e) => set("boundaries", e.target.value)} />
              </Field>
              <Field label="Conversation starters" hint="Suggestions shown in a new chat. Clicking one sends it as your message, so write what a person would ask, e.g. “Help me draft an email.”">
                <div className="space-y-2">
                  {[...form.starters, ""].slice(0, 6).map((s, i) => (
                    <Input
                      key={i}
                      value={s}
                      aria-label={`Conversation starter ${i + 1}`}
                      placeholder={i === form.starters.length ? "Add a starter, e.g. Summarize this and list the action items" : ""}
                      onChange={(e) => {
                        const next = [...form.starters];
                        next[i] = e.target.value;
                        set("starters", next.filter((x, j) => x || j < next.length - 1));
                      }}
                    />
                  ))}
                </div>
              </Field>

              </>}
              <Field label="Bot engine" hint="Native bots use CollectiveUI tools with a selected model. Hermes runs the bot with its own tools, memory and model routing.">
                <Select disabled={(managed && !personalNew) || service} aria-label="Bot engine" value={engine} onChange={(e) => {
                  const next = e.target.value as "native" | "hermes";
                  setEngineChoice(next);
                  // Changing engines requires an explicit connection choice before saving.
                  set("appId", "");
                  set("coordinatorEligible", false);
                  set("isCoordinator", false);
                  if (!botId) set("delegatorIds", []);
                }}>
                  <option value="native">Native · CollectiveUI</option>
                  <option value="hermes">{local ? "Local Hermes" : "Hermes"}</option>
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={engine === "hermes" ? "Agent backend connection" : "Model connection"}
                  hint={local ? "This bot uses the explicitly selected local profile and its paired model. Changes to native configuration belong in Hermes." : engine === "hermes" ? "Choose the Hermes profile this bot should use. The backend controls its models; /model uses only approved routes." : "Each connection selects a model or deployment from a provider."}>
                  <Select disabled={managed && !personalNew} aria-label={engine === "hermes" ? "Agent backend connection" : "Model connection"} value={form.appId} onChange={(e) => {
                    set("appId", e.target.value);
                    if (e.target.value === "personal-hermes") {
                      set("visibility", "private"); set("groupIds", []); set("tools", []); set("delegateIds", []);
                      set("instructions", ""); set("boundaries", ""); set("executionMode", "caller");
                    }
                  }}>
                    <option value="">Choose a connection…</option>
                    {form.appId && !personalNew && !connections.some((a) => a.id === form.appId) && <option value={form.appId} disabled>Unavailable connection</option>}
                    {engine === "hermes" && personalHermesAvailable && !botId && <option value="personal-hermes">My Hermes runtime · new private profile</option>}
                    {connections.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{!a.agentServer && a.model ? ` · ${a.model}` : ""}
                        {!a.agentServer && !a.supportsTools ? " (no tools)" : ""}
                      </option>
                    ))}
                  </Select>
                  {!connections.length && !(engine === "hermes" && personalHermesAvailable) && <p role="status" className="text-sm text-muted">No {engine === "hermes" ? "Hermes backends" : "model connections"} are available. Ask an admin to configure Connections.</p>}
                </Field>
                {engine === "native" && <Field label="Max steps per run">
                  <Input aria-label="Max steps per run" type="number" min={1} max={50} value={form.maxSteps} onChange={(e) => set("maxSteps", Number(e.target.value))} />
                </Field>}
              </div>

              <Field label="Who can use it">
                <Select disabled={local || personalNew} aria-label="Who can use it" value={form.visibility} onChange={(e) => set("visibility", e.target.value as BotInput["visibility"])}>
                  <option value="private">Only me</option>
                  <option value="groups">Specific groups or users</option>
                  <option value="org">Everyone in the organization</option>
                </Select>
              </Field>
              {form.visibility === "groups" && (
                <div className="space-y-4">
                  <Field label="Groups"><div className="flex flex-wrap gap-2">
                  {groups.map((g) => {
                    const on = form.groupIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        onClick={() => set("groupIds", on ? form.groupIds.filter((x) => x !== g.id) : [...form.groupIds, g.id])}
                        className={cn("rounded-full border px-3 py-1 text-sm", on ? "border-fg bg-fg text-bg" : "border-border")}
                      >
                        {g.name}
                      </button>
                    );
                  })}
                  {!groups.length && <p className="text-sm text-muted">No groups defined yet (Admin → Groups).</p>}
                  </div></Field>
                  <Field label="Individual users" hint="Select groups, users, or both. Selected users can chat with this bot; only its owner and admins can edit it.">
                    <UserPicker users={users} value={form.userIds ?? []} onChange={ids => set("userIds", ids)} />
                  </Field>
                </div>
              )}

              {isAdmin && engine === "hermes" && !personalNew && team && <HermesTeamPolicy value={team} onChange={setTeam} maintainers={teamMaintainers} modelOptions={teamModelOptions} disabled={pending} />}

              {isAdmin && engine === "native" && (
                <Field label="Connector permissions" hint="Service bots are managed by admins and grant only reviewed MCP capabilities through direct chats.">
                  <Select aria-label="Connector permissions" value={form.executionMode ?? "caller"} onChange={(e) => {
                    const mode = e.target.value as "caller" | "service";
                    setForm((f) => ({ ...f, executionMode: mode, ...(mode === "service" ? {
                      tools: f.tools.filter((t) => t.key.startsWith("mcp:")), delegateIds: [], coordinatorEligible: false, isCoordinator: false,
                      ...(!botId ? { delegatorIds: [] } : {}),
                    } : {}) }));
                  }}>
                    <option value="caller">Use each caller&apos;s connector access</option>
                    <option value="service">Admin-managed service bot</option>
                  </Select>
                </Field>
              )}
              {engine === "hermes" ? (
                <div className="rounded-xl border border-border bg-surface-2/40 px-3 py-2.5 text-sm text-muted">
                  {local ? "Tools, memory, skills and persona live in the selected native profile. CollectiveUI does not add or replace its standing instructions. Native flagged commands ask for approval in this chat." : "Tools, memory, skills and persona live in Hermes for this bot. The instructions above are added on top of the Hermes profile’s own; flagged commands ask for approval in the chat."}
                </div>
              ) : (
                <>
              <div>
                <div className="mb-1.5 text-sm font-medium">Tools</div>
                <p className="mb-2 text-xs text-muted">MCP connectors appear after an admin saves, tests and enables them, and grants you direct access. Admins can select any enabled connector. Plain model chats offer OpenAI native search separately.</p>
                {service && <p className="mb-2 text-xs text-muted">Only reviewed MCP tools are supported. Built-in tools, delegation, groups and routines are unavailable in service mode.</p>}
                {!app?.supportsTools && <p className="mb-2 text-xs text-danger">The selected model doesn&apos;t support tools.</p>}
                <div className="divide-y divide-border rounded-xl border border-border">
                  {tools.filter((t) => !service || t.key.startsWith("mcp:")).map((t) => {
                    const on = toolOn(t.key);
                    const searchReason = t.key === "openai_web_search" ? app?.nativeSearchReason : null;
                    const isMcp = t.key.startsWith("mcp:");
                    const replace = (c: ToolChoice) => set("tools", form.tools.map((x) => (x.key === t.key ? c : x)));
                    return (
                      <div key={t.key}>
                        <div className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 px-3 py-2.5 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
                          <input
                            type="checkbox"
                            id={`bot-tool-${t.key}`}
                            aria-label={t.label}
                            checked={!!on}
                            disabled={!on && !!searchReason}
                            onChange={(e) => toggleTool(t, e.target.checked)}
                            className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
                          />
                          <label htmlFor={`bot-tool-${t.key}`} className="min-w-0 cursor-pointer wrap-anywhere">
                            <span className="block text-sm font-medium">{t.label}</span>
                            <span className="block text-xs text-muted">{searchReason ?? t.description}</span>
                          </label>
                          {on && !service && t.key !== "openai_web_search" && (
                            <Select
                              value={on.approval}
                              onChange={(e) => replace({ ...on, approval: e.target.value as ApprovalMode })}
                              className="col-start-2 h-9 w-fit max-w-full px-2.5 text-xs sm:col-start-3 sm:row-start-1"
                              aria-label={`${t.label} approval`}
                            >
                              <option value="auto">{APPROVAL_LABELS.auto}</option>
                              <option value="ask">{APPROVAL_LABELS.ask}</option>
                              {(isMcp || on.approval === "smart") && <option value="smart">{APPROVAL_LABELS.smart}</option>}
                            </Select>
                          )}
                          {on && t.key === "openai_web_search" && <p className="col-start-2 text-xs text-muted sm:col-span-2">{SEARCH_COST_NOTICE}</p>}
                        </div>
                        {on && isMcp && <McpToolChoices option={t} choice={on} onChange={replace} service={service} />}
                      </div>
                    );
                  })}
                </div>
              </div>
              {service && <ServiceGrantEditor botId={botId} revision={revision} publishedRevision={publishedRevision} publicationStatus={publicationStatus}
                dirty={JSON.stringify(form) !== JSON.stringify(initial)} choices={form.tools} options={tools} initial={serviceGrants} />}

              {!service && engine === "native" && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" aria-label="Coordinator" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={form.isCoordinator ?? false}
                    onChange={e => set("isCoordinator", e.target.checked)} />
                  <span>Coordinator<span className="mt-1 block text-xs text-muted">Preselect this bot as a delegator when its editors create new bots. They can change that selection. Existing teams and the organization start bot stay unchanged.</span></span>
                </label>
              )}
              {!botId && !service && engine === "native" && (
                <Field label="Delegators" hint="These coordinators will be able to hand work to this bot. Only coordinators you can edit and use are offered; each caller still needs access to both bots and their models. Change this later in the coordinator's Team.">
                  <div className="flex flex-wrap gap-2">
                    {delegators.map(d => {
                      const on = form.delegatorIds?.includes(d.id) ?? false;
                      return <button type="button" key={d.id} aria-pressed={on} aria-label={`Delegator: ${d.name}`}
                        onClick={() => setForm(f => ({ ...f, delegatorIds: f.delegatorIds?.includes(d.id)
                          ? f.delegatorIds.filter(id => id !== d.id) : [...(f.delegatorIds ?? []), d.id] }))}
                        className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm", on ? "border-fg bg-fg text-bg" : "border-border")}>
                        <BotAvatar botId={d.id} value={d.avatar} className="h-4 w-4" /> {d.name}
                      </button>;
                    })}
                  </div>
                  {!delegators.length && <p className="text-xs text-muted">No eligible coordinators. Enable Coordinator on a native bot you can edit and configure its model first.</p>}
                </Field>
              )}
              {!service && engine === "native" && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={form.coordinatorEligible ?? false}
                    onChange={e => set("coordinatorEligible", e.target.checked)} />
                  <span>Allow coordinator delegation<span className="mt-1 block text-xs text-muted">The installation coordinator can discover this bot for people who already have access. Its tools and approval rules still apply. Manual team links work independently.</span></span>
                </label>
              )}
              {!service && delegates.length > 0 && (
                <Field label="Team (delegation)" hint="This bot can hand work to these specialist bots — the chief-of-staff pattern.">
                  <div className="flex flex-wrap gap-2">
                    {delegates.map((d) => {
                      const on = form.delegateIds.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => set("delegateIds", on ? form.delegateIds.filter((x) => x !== d.id) : [...form.delegateIds, d.id])}
                          className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm", on ? "border-fg bg-fg text-bg" : "border-border")}
                        >
                          <BotAvatar value={d.avatar} className="h-4 w-4" /> {d.name}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}

              {botId && !service && (
                <div>
                  <div className="mb-1.5 text-sm font-medium">Knowledge</div>
                  <div className="space-y-2">
                    {knowledge.map((k) => (
                      <div key={k.attachmentId} className="flex items-center gap-3 rounded-xl border border-border px-3 py-2 text-sm">
                        <FileText className="h-4 w-4 text-muted" />
                        <span className="flex-1 truncate">{k.filename}</span>
                        <span className="text-xs text-subtle">{k.chunks} chunks</span>
                        <button
                          onClick={async () => {
                            await removeKnowledgeFile(botId, k.attachmentId);
                            router.refresh();
                          }}
                          aria-label={`Remove ${k.filename}`}
                          className="text-muted hover:text-danger"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-border px-3 py-3 text-sm text-muted hover:bg-hover">
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      Upload files (PDF, Word, text…)
                      <input type="file" multiple hidden onChange={(e) => e.target.files && uploadKnowledge(e.target.files)} />
                    </label>
                  </div>
                </div>
              )}
                </>
              )}
            </div>
          )}

          <div className="sticky bottom-0 mt-6 flex items-center gap-2 border-t border-border bg-bg py-3">
            <Button onClick={save} disabled={pending || !form.name.trim() || !form.appId}>
              {pending && <Loader2 className="h-4 w-4 animate-spin" />} {botId ? service ? "Save draft" : "Update" : "Create"}
            </Button>
            {botId && (
              <BotDeleteButton
                botId={botId}
                botName={initial.name}
                redirectTo="/bots"
                disabled={pending}
                className="ml-auto text-danger"
              />
            )}
          </div>
        </div>
      </div>
      <div className="hidden min-h-0 flex-col lg:flex">
        <div className="flex items-center gap-2 px-4 pt-3 text-sm font-medium text-muted">
          <Sparkles className="h-4 w-4" /> Preview
        </div>
        <div className="min-h-0 flex-1">
          {previewTarget ? (
            <Chat embedded key={newChatId} isNew target={previewTarget} initialRows={[]} initialLeafId={null} />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">Create the bot to preview it here.</div>
          )}
        </div>
      </div>
    </div>
  );
}
