"use client";

import { cloneElement, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, ArrowDownToLine, Check, ChevronRight, CircleHelp, Cpu, HardDrive,
  Loader2, Network, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users, X,
} from "lucide-react";
import { performDockerSandboxAction, readDockerSandboxes } from "@/app/admin/docker-sandboxes/actions";
import type {
  AdminCheck, AdminNetwork, AdminTemplate, AdminValidation, SandboxAdminAction,
  SandboxAdminPageData, SandboxAdminResult,
} from "@/personal-codex/admin-contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Badge, Card, Stat } from "./ui";

type TabId = "overview" | "templates" | "network" | "resources" | "access";
const TABS: { id: TabId; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "templates", label: "Templates", icon: HardDrive },
  { id: "network", label: "Network", icon: Network },
  { id: "resources", label: "Resources", icon: Cpu },
  { id: "access", label: "Access & validation", icon: ShieldCheck },
];
const CHECK_LABELS: Record<string, string> = { sbx: "SBX connection", desktop: "Desktop runtime", containment: "Isolation", inference: "Authenticated inference" };
const PINNED_IMAGE = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;
const NETWORK_HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
const date = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : "Not recorded";
const humanMemory = (mb: number) => mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactElement<{ id?: string; "aria-describedby"?: string }> }) {
  const id = useId();
  const child = children as React.ReactElement<{ id?: string; "aria-describedby"?: string }>;
  const describedBy = [child.props["aria-describedby"], hint ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;
  return <div className="space-y-1"><label htmlFor={id} className="block text-sm font-medium">{label}</label>{cloneElement(child, { id, "aria-describedby": describedBy })}{hint && <p id={`${id}-hint`} className="text-xs text-muted">{hint}</p>}</div>;
}

function StateBadge({ state, label: customLabel }: { state: string; label?: string }) {
  const tone = state === "running" || state === "passed" || state === "synchronized" || state === "agent" ? "green"
    : state === "failed" || state === "unavailable" || state === "sync_required" ? "red"
      : state === "human" || state === "paused" ? "blue" : state === "stopped" || state === "missing" ? "amber" : "default";
  const label: Record<string, string> = { sync_required: "sync needed", operator_unverified: "operator unverified", missing: "not provisioned", unknown: "unknown", human: "owner has control", agent: "agent has control", paused: "agent paused" };
  return <Badge tone={tone}>{customLabel ?? label[state] ?? state}</Badge>;
}

function CheckList({ checks }: { checks: AdminCheck[] }) {
  if (!checks.length) return <p className="text-sm text-muted">No host checks have been recorded yet.</p>;
  return <div className="divide-y divide-border rounded-xl border border-border">
    {checks.map((check) => <div key={check.id} className="flex items-start gap-3 px-3 py-3">
      {check.state === "passed" ? <Check aria-hidden className="mt-0.5 h-4 w-4 text-success" /> : check.state === "failed" ? <X aria-hidden className="mt-0.5 h-4 w-4 text-danger" /> : <CircleHelp aria-hidden className="mt-0.5 h-4 w-4 text-muted" />}
      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{check.label}</span><StateBadge state={check.state} /></div><p className="mt-1 text-sm text-muted">{check.detail}</p></div>
    </div>)}
  </div>;
}

function downloadDiagnostics(result: SandboxAdminResult) {
  const payload = result.diagnostics;
  if (!payload) return;
  const blob = new Blob([JSON.stringify({ report: "Sanitized Docker computer host diagnostics", checkedAt: payload.checkedAt, source: payload.source, liveComputerUseVerified: false, checks: payload.checks }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `computer-diagnostics-${new Date(payload.checkedAt).toISOString().slice(0, 10)}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DockerSandboxesAdmin({ initialData }: { initialData: SandboxAdminPageData }) {
  const [data, setData] = useState(initialData);
  const [tab, setTab] = useState<TabId>("overview");
  const [selectedOwner, setSelectedOwner] = useState(initialData.runtimes[0]?.ownerId ?? "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [diagnosticDialog, setDiagnosticDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ ownerId: string; name: string } | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [diagnosticResult, setDiagnosticResult] = useState<SandboxAdminResult["diagnostics"] | null>(null);
  const [network, setNetwork] = useState<AdminNetwork | null>(null);
  const [networkLoad, setNetworkLoad] = useState<"idle" | "loading" | "ready" | "error">(initialData.runtimes.length ? "loading" : "idle");
  const [networkCheck, setNetworkCheck] = useState<SandboxAdminResult["networkCheck"] | null>(null);
  const [destination, setDestination] = useState("");
  const [checkDestination, setCheckDestination] = useState("");
  const [networkEffect, setNetworkEffect] = useState<"allow" | "deny">("allow");
  const [templateRef, setTemplateRef] = useState("");
  const [importTemplateRef, setImportTemplateRef] = useState("");
  const [templateLabel, setTemplateLabel] = useState("");
  const [archive, setArchive] = useState("");
  const [defaultTemplate, setDefaultTemplate] = useState(initialData.settings.defaultTemplate);
  const [cpus, setCpus] = useState(String(initialData.settings.cpus));
  const [memoryMb, setMemoryMb] = useState(String(initialData.settings.memoryMb));
  const [maxRunning, setMaxRunning] = useState(String(initialData.settings.maxRunning));
  const [validationId, setValidationId] = useState<AdminValidation["id"]>("sbx");
  const [validationResult, setValidationResult] = useState<AdminValidation["result"]>("passed");
  const [validationReference, setValidationReference] = useState("");
  const networkRequestId = useRef(0);
  const selectedOwnerRef = useRef(initialData.runtimes[0]?.ownerId ?? "");

  const enabledRuntimes = useMemo(() => data.runtimes.filter((runtime) => runtime.admitted), [data.runtimes]);
  const filteredRuntimes = useMemo(() => {
    const term = query.trim().toLowerCase();
    return data.runtimes.filter((runtime) => {
      const person = data.people.find((entry) => entry.id === runtime.ownerId);
      return !term || `${person?.name ?? ""} ${person?.email ?? ""} ${runtime.ownerId}`.toLowerCase().includes(term);
    });
  }, [data.runtimes, data.people, query]);
  const currentRuntime = data.runtimes.find((runtime) => runtime.ownerId === selectedOwner) ?? null;
  const currentPerson = data.people.find((person) => person.id === selectedOwner);
  const lifecycleBlocked = !!currentRuntime && (!currentRuntime.admitted || !!currentPerson?.disabled);
  const hostReady = data.available && data.checks.length > 0 && data.checks.every((check) => check.state === "passed");
  const disabledReason = !data.available ? data.reason ?? "Set up the Docker sandbox host before managing computers." : null;

  async function loadNetwork(ownerId: string) {
    const requestId = ++networkRequestId.current;
    try {
      const { result } = await performDockerSandboxAction({ action: "network-read", ownerId });
      if (requestId === networkRequestId.current && ownerId === selectedOwnerRef.current) {
        setNetwork(result.network ?? null);
        setNetworkLoad(result.network ? "ready" : "error");
      }
    } catch {
      if (requestId === networkRequestId.current && ownerId === selectedOwnerRef.current) {
        setNetwork(null);
        setNetworkLoad("error");
      }
    }
  }

  useEffect(() => {
    if (!selectedOwner) return;
    const request = window.setTimeout(() => { void loadNetwork(selectedOwner); }, 0);
    return () => window.clearTimeout(request);
  }, [selectedOwner]);

  async function submit(action: SandboxAdminAction, successFallback?: string) {
    const isNetworkAction = action.action === "network-add" || action.action === "network-remove" || action.action === "network-check" || action.action === "network-read";
    const networkOwner = isNetworkAction ? action.ownerId : null;
    const networkRequest = isNetworkAction ? ++networkRequestId.current : null;
    setBusy(true);
    setNotice(null);
    try {
      const response = await performDockerSandboxAction(action);
      setData(response.data);
      if (action.action === "network-add" || action.action === "network-remove" || action.action === "network-read") {
        if (networkRequest === networkRequestId.current && networkOwner === selectedOwnerRef.current) {
          if (response.result.network) setNetwork(response.result.network);
          setNetworkLoad(response.result.network ? "ready" : "error");
        }
      }
      if (action.action === "network-check") {
        if (networkRequest === networkRequestId.current && networkOwner === selectedOwnerRef.current) {
          if (response.result.network) setNetwork(response.result.network);
          setNetworkCheck(response.result.networkCheck ?? null);
          if (response.result.network) setNetworkLoad("ready");
        }
      }
      if (action.action === "diagnose") setDiagnosticResult(response.result.diagnostics ?? null);
      const message = response.result.message || successFallback || "Saved.";
      setNotice({ ok: true, text: message });
      toast.success(message);
      return response.result;
    } catch (error) {
      if (isNetworkAction && networkRequest === networkRequestId.current && networkOwner === selectedOwnerRef.current && action.action === "network-read") setNetworkLoad("error");
      const message = error instanceof Error ? error.message : "The change could not be completed.";
      setNotice({ ok: false, text: message });
      toast.error(message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      const fresh = await readDockerSandboxes();
      setData(fresh);
      setDefaultTemplate(fresh.settings.defaultTemplate);
      setCpus(String(fresh.settings.cpus));
      setMemoryMb(String(fresh.settings.memoryMb));
      setMaxRunning(String(fresh.settings.maxRunning));
      setNotice({ ok: true, text: "Host and owner inventory refreshed." });
      if (tab === "network" && selectedOwnerRef.current) {
        setNetworkLoad("loading");
        void loadNetwork(selectedOwnerRef.current);
      }
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : "Could not refresh the host status." });
    } finally { setBusy(false); }
  }

  async function diagnose() {
    const result = await submit({ action: "diagnose" });
    if (result?.diagnostics) setDiagnosticDialog(true);
  }

  function selectOwner(ownerId: string) {
    networkRequestId.current += 1;
    selectedOwnerRef.current = ownerId;
    setNetwork(null);
    setNetworkCheck(null);
    setNetworkLoad(ownerId ? "loading" : "idle");
    setSelectedOwner(ownerId);
  }

  const tabs = <div role="tablist" aria-label="Computer administration sections" onKeyDown={(event) => {
    const currentIndex = TABS.findIndex((item) => item.id === tab);
    const nextIndex = event.key === "ArrowRight" ? (currentIndex + 1) % TABS.length
      : event.key === "ArrowLeft" ? (currentIndex - 1 + TABS.length) % TABS.length
        : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
    if (nextIndex >= 0) {
      event.preventDefault();
      const nextTab = TABS[nextIndex];
      setTab(nextTab.id);
      event.currentTarget.querySelector<HTMLButtonElement>(`#docker-tab-${nextTab.id}`)?.focus();
    }
  }} className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-surface-2 p-1">
    {TABS.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" id={`docker-tab-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} aria-controls={`docker-panel-${id}`} onClick={() => setTab(id)} className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${tab === id ? "bg-bg font-medium shadow-sm" : "text-muted hover:text-fg"}`}>
      <Icon aria-hidden className="h-4 w-4" />{label}
    </button>)}
  </div>;

  const panelProps = (id: TabId) => ({ role: "tabpanel" as const, id: `docker-panel-${id}`, "aria-labelledby": `docker-tab-${id}`, tabIndex: 0 as const, className: "mt-5 outline-none focus-visible:ring-2 focus-visible:ring-fg/30 rounded-xl" });
  const actionDisabled = busy || !data.available;
  const validInteger = (value: string, min: number, max: number) => /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
  const resourcesValid = validInteger(cpus, 1, 64) && validInteger(memoryMb, 512, 65536) && validInteger(maxRunning, 1, 1000);
  const validTemplateLabel = !!templateLabel.trim() && templateLabel.trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(templateLabel);
  const validValidationReference = !!validationReference.trim() && validationReference.trim().length <= 300 && !/[\x00-\x1f\x7f]/.test(validationReference);
  const validDestination = (value: string) => {
    const normalized = value.trim().toLowerCase();
    const port = normalized.includes(":") ? Number(normalized.split(":").at(-1)) : null;
    return NETWORK_HOST.test(normalized) && !normalized.includes("..") && (port === null || (port >= 1 && port <= 65535));
  };

  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2/50 p-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">Docker Sandboxes</h2><Badge tone={data.available ? "green" : "red"}>{data.available ? "Connected" : "Unavailable"}</Badge><Badge>{data.backend === "sbx" ? "SBX" : data.backend === "docker" ? "Docker" : "Not configured"}</Badge></div>
        <p className="mt-1 text-xs text-muted">Checked {date(data.checkedAt)}{data.version ? ` · host ${data.version}` : ""}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw aria-hidden className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />Refresh</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void diagnose()}><ArrowDownToLine aria-hidden className="h-4 w-4" />Diagnostics</Button>
      </div>
    </div>
    {notice && <p role={notice.ok ? "status" : "alert"} className={`rounded-xl border px-3 py-2 text-sm ${notice.ok ? "border-success/30 bg-success/5 text-success" : "border-danger/30 bg-danger/5 text-danger"}`}>{notice.text}</p>}
    {!data.available && <div role="status" className="flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
      <div><p className="font-medium">Computer host setup is needed</p><p className="mt-1 text-muted">{disabledReason} Owner and template information already on file remains visible. Provisioning and host controls are disabled until the host is available.</p><a className="mt-2 inline-flex items-center gap-1 font-medium underline underline-offset-4" href="/admin/sandboxes">Open the host setup runbook <ChevronRight aria-hidden className="h-3.5 w-3.5" /></a></div>
    </div>}
    {tabs}
    {tab === "overview" && <section {...panelProps("overview")}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Host health" value={data.available ? hostReady ? "Ready" : "Needs attention" : "Unavailable"} sub={`${data.checks.filter((check) => check.state === "passed").length} of ${data.checks.length} checks passed`} />
        <Stat label="Owners admitted" value={data.settings.admittedOwners.length} sub="Eligible for a computer" />
        <Stat label="Computers running" value={data.runtimes.filter((runtime) => runtime.state === "running").length} sub={`Maximum ${data.settings.maxRunning} at once`} />
        <Stat label="Templates" value={data.templates.length} sub={`${data.templates.filter((template) => template.available).length} available on host`} />
      </div>
      <Card className={`mt-4 ${hostReady ? "border-success/30 bg-success/5" : "border-amber-500/30 bg-amber-500/5"}`}>
        <div className="flex items-start gap-3"><ShieldCheck aria-hidden className={`mt-0.5 h-5 w-5 shrink-0 ${hostReady ? "text-success" : "text-amber-600"}`} /><div className="min-w-0 flex-1"><h3 className="font-medium">Computer readiness</h3><p className="mt-1 text-sm text-muted">Host health and runtime checks describe setup readiness. They do not indicate that a person is signed in or that a computer task has succeeded.</p><div className="mt-4"><CheckList checks={data.checks} /></div></div></div>
      </Card>
      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Card className="min-w-0 p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4"><div><h3 className="font-medium">Owner inventory</h3><p className="mt-1 text-xs text-muted">Provisioned computers and access assignments.</p></div><div className="relative w-full sm:w-56"><Search aria-hidden className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" /><Input aria-label="Search computer owners" placeholder="Search people" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" /></div></div>
          <div className="max-h-[520px] overflow-y-auto">
            {filteredRuntimes.map((runtime) => {
              const person = data.people.find((entry) => entry.id === runtime.ownerId);
              return <button type="button" key={runtime.ownerId} disabled={busy} onClick={() => selectOwner(runtime.ownerId)} aria-pressed={selectedOwner === runtime.ownerId} className={`flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-fg disabled:opacity-60 ${selectedOwner === runtime.ownerId ? "bg-surface-2" : ""}`}>
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted"><Users aria-hidden className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{person?.name ?? "Unknown owner"}</p><p className="truncate text-xs text-muted">{person?.email ?? runtime.ownerId}{person?.disabled ? " · disabled account" : ""}</p></div>
                <span className="hidden sm:block"><StateBadge state={runtime.state} /></span><ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-subtle" />
              </button>;
            })}
            {!filteredRuntimes.length && <p className="p-8 text-center text-sm text-muted">{data.runtimes.length ? "No owners match that search." : "No computers are registered yet. Admit a person in Access & validation to get started."}</p>}
          </div>
        </Card>
        <Card className="space-y-4">
          <div><p className="text-xs font-medium uppercase tracking-wide text-muted">Selected owner</p><h3 className="mt-1 text-lg font-semibold">{currentPerson?.name ?? (selectedOwner ? "Unknown owner" : "Choose a person")}</h3><p className="text-sm text-muted">{currentPerson?.email ?? "Select a person from the inventory."}</p></div>
          {currentRuntime ? <>
            <div className="flex flex-wrap items-center gap-2"><StateBadge state={currentRuntime.state} /><StateBadge state={currentRuntime.credentialState} /><StateBadge state={currentRuntime.computer.control} /></div>
            {currentRuntime.computer.paused && <p className="rounded-xl bg-blue-500/10 px-3 py-2 text-sm text-blue-800 dark:text-blue-300">Automation is paused. The owner can return control from their computer viewer.</p>}
            {!currentRuntime.admitted && <p className="text-xs text-muted">Admit this owner before provisioning or starting a computer.</p>}
            {currentPerson?.disabled && <p className="text-xs text-muted">This account is disabled. Its computer can’t be provisioned or started.</p>}
            <div className="grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-surface-2 p-3"><p className="text-xs text-muted">Last frame</p><p className="mt-1 font-medium">{date(currentRuntime.computer.lastFrameAt)}</p></div><div className="rounded-xl bg-surface-2 p-3"><p className="text-xs text-muted">Active sessions</p><p className="mt-1 font-medium">{currentRuntime.activeSessions ?? "Unknown"}</p></div></div>
            <p className="break-all text-xs text-muted">Template <span className="font-mono">{currentRuntime.template || "Not assigned"}</span></p>
            <div className="flex flex-wrap gap-2">
              {!currentRuntime.admitted && <Button size="sm" disabled={actionDisabled || !!currentPerson?.disabled} title={currentPerson?.disabled ? "Disabled people cannot be enrolled." : undefined} onClick={() => void submit({ action: "enrollment", revision: data.settings.revision, ownerId: currentRuntime.ownerId, admitted: true })}>Admit owner</Button>}
              {currentRuntime.state === "missing" && <Button size="sm" disabled={actionDisabled || lifecycleBlocked} title={lifecycleBlocked ? "Admit an enabled owner before provisioning." : undefined} onClick={() => void submit({ action: "lifecycle", ownerId: currentRuntime.ownerId, operation: "provision" })}>Provision</Button>}
              {currentRuntime.state === "stopped" && <Button size="sm" disabled={actionDisabled || lifecycleBlocked} title={lifecycleBlocked ? "Admit an enabled owner before starting." : undefined} onClick={() => void submit({ action: "lifecycle", ownerId: currentRuntime.ownerId, operation: "start" })}>Start computer</Button>}
              {currentRuntime.state === "running" && <Button size="sm" variant="outline" disabled={actionDisabled} onClick={() => void submit({ action: "lifecycle", ownerId: currentRuntime.ownerId, operation: "stop" })}>Stop computer</Button>}
              {currentRuntime.state !== "missing" && <Button size="sm" variant="danger" disabled={actionDisabled} onClick={() => { setDeleteConfirmation(""); setDeleteTarget({ ownerId: currentRuntime.ownerId, name: currentPerson?.name ?? "this owner" }); }}>Delete computer</Button>}
            </div>
          </> : <p className="text-sm text-muted">No computer is registered for this person.</p>}
        </Card>
      </div>
    </section>}
    {tab === "templates" && <section {...panelProps("templates")} className="mt-5 space-y-4 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-fg/30">
      <Card className="space-y-4"><div><h3 className="font-medium">Approved image templates</h3><p className="mt-1 text-sm text-muted">Only pinned image digests can be selected for new computers. Changing the default affects new runtimes, not computers already running.</p></div>
        <Field label="Default template for new computers"><Select value={defaultTemplate} onChange={(event) => setDefaultTemplate(event.target.value)} disabled={!data.templates.length}><option value="">Choose an approved template</option>{data.templates.map((template) => <option key={template.reference} value={template.reference} disabled={!template.available}>{template.label} · {template.available === null ? "availability unknown" : template.available ? "available" : "not on host"}</option>)}</Select></Field>
        <Button disabled={actionDisabled || !defaultTemplate} onClick={() => void submit({ action: "settings", revision: data.settings.revision, cpus: Number(cpus), memoryMb: Number(memoryMb), maxRunning: Number(maxRunning), defaultTemplate })}>Save default template</Button>
        <div className="divide-y divide-border rounded-xl border border-border">{data.templates.map((template) => <TemplateRow key={template.reference} template={template} isDefault={template.reference === data.settings.defaultTemplate} disabled={actionDisabled} onRemove={() => void submit({ action: "template-remove", revision: data.settings.revision, reference: template.reference })} />)}{!data.templates.length && <p className="p-4 text-sm text-muted">No approved templates yet. Add an immutable image reference below.</p>}</div>
      </Card>
      <Card className="space-y-4"><div><h3 className="font-medium">Add a pinned template</h3><p className="mt-1 text-sm text-muted">Use a lowercase registry/name@sha256 digest so the image contents cannot change after approval.</p></div><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Field label="Template name"><Input maxLength={100} aria-invalid={!!templateLabel && !validTemplateLabel} aria-describedby="template-label-error" value={templateLabel} onChange={(event) => setTemplateLabel(event.target.value)} placeholder="Browser computer" /></Field><Field label="Pinned image reference"><Input aria-invalid={!!templateRef.trim() && !PINNED_IMAGE.test(templateRef.trim())} aria-describedby="template-reference-error" value={templateRef} onChange={(event) => setTemplateRef(event.target.value)} placeholder="registry.example/browser@sha256:…" className="font-mono text-xs" /></Field><div className="flex items-end"><Button disabled={actionDisabled || !validTemplateLabel || !PINNED_IMAGE.test(templateRef.trim())} onClick={() => void submit({ action: "template-add", revision: data.settings.revision, label: templateLabel, reference: templateRef })}><Plus aria-hidden className="h-4 w-4" />Approve</Button></div></div>{!!templateLabel && !validTemplateLabel && <p id="template-label-error" role="alert" className="text-xs text-danger">Enter a template name up to 100 characters without control characters.</p>}{!!templateRef.trim() && !PINNED_IMAGE.test(templateRef.trim()) && <p id="template-reference-error" role="alert" className="text-xs text-danger">Enter a lowercase image name pinned to a 64-character sha256 digest.</p>}</Card>
      <Card className="space-y-4"><div><h3 className="font-medium">Import from host inbox</h3><p className="mt-1 text-sm text-muted">Import a reviewed tar archive already present in the host inbox. This does not upload local files.</p></div><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><Field label="Host inbox archive"><Select value={archive} onChange={(event) => setArchive(event.target.value)}><option value="">Choose an archive</option>{data.archives.map((item) => <option key={item.name} value={item.name}>{item.name} · {formatBytes(item.sizeBytes)}</option>)}</Select></Field><Field label="Pinned image reference"><Input aria-invalid={!!importTemplateRef.trim() && !PINNED_IMAGE.test(importTemplateRef.trim())} aria-describedby="import-reference-error" value={importTemplateRef} onChange={(event) => setImportTemplateRef(event.target.value)} placeholder="registry.example/browser@sha256:…" className="font-mono text-xs" /></Field><div className="flex items-end"><Button variant="outline" disabled={actionDisabled || !archive || !PINNED_IMAGE.test(importTemplateRef.trim())} onClick={() => void submit({ action: "template-import", revision: data.settings.revision, archive, reference: importTemplateRef })}>Import archive</Button></div></div>{!!importTemplateRef.trim() && !PINNED_IMAGE.test(importTemplateRef.trim()) && <p id="import-reference-error" role="alert" className="text-xs text-danger">Enter a lowercase image name pinned to a 64-character sha256 digest.</p>}{!data.archives.length && <p className="text-xs text-muted">The host inbox is empty.</p>}</Card>
    </section>}
    {tab === "network" && <section {...panelProps("network")} className="mt-5 space-y-4 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-fg/30">
      <Card className="space-y-4"><div><h3 className="font-medium">Owner network policy</h3><p className="mt-1 text-sm text-muted">Rules are evaluated by the sandbox network boundary. Observed logs are host-reported and may be unavailable.</p></div><Field label="Choose computer owner"><Select value={selectedOwner} disabled={busy} onChange={(event) => selectOwner(event.target.value)}><option value="">Choose a person</option>{data.runtimes.map((runtime) => { const person = data.people.find((entry) => entry.id === runtime.ownerId); return <option key={runtime.ownerId} value={runtime.ownerId}>{person?.name ?? runtime.ownerId} · {person?.email ?? "unknown email"}</option>; })}</Select></Field>
        <div className="grid gap-3 sm:grid-cols-[180px_1fr_auto]"><Field label="Rule"><Select value={networkEffect} onChange={(event) => setNetworkEffect(event.target.value as "allow" | "deny")}><option value="allow">Allow</option><option value="deny">Deny</option></Select></Field><Field label="Host or IP address"><Input aria-invalid={!!destination.trim() && !validDestination(destination)} aria-describedby="network-destination-error" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="docs.example.com or *.example.com:443" onKeyDown={(event) => { if (event.key === "Enter" && selectedOwner && validDestination(destination)) void submit({ action: "network-add", ownerId: selectedOwner, effect: networkEffect, destination }); }} /></Field><div className="flex items-end"><Button disabled={actionDisabled || !selectedOwner || !validDestination(destination)} onClick={() => void submit({ action: "network-add", ownerId: selectedOwner, effect: networkEffect, destination })}><Plus aria-hidden className="h-4 w-4" />Add rule</Button></div></div>{!!destination.trim() && !validDestination(destination) && <p id="network-destination-error" role="alert" className="text-xs text-danger">Enter a hostname or IPv4 address, optionally with a port from 1 to 65535.</p>}
        {!network && networkLoad === "loading" && <p role="status" className="text-sm text-muted">Loading owner policy…</p>}
        {!network && networkLoad === "error" && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-sm"><span>Could not load the owner&apos;s network policy.</span><Button size="sm" variant="outline" disabled={actionDisabled || !selectedOwner} onClick={() => { setNetworkLoad("loading"); void loadNetwork(selectedOwner); }}>Try again</Button></div>}
        {!network && networkLoad === "idle" && <p className="text-sm text-muted">Select an owner to view their policy.</p>}
        {network && <><div className="flex flex-wrap gap-2 text-xs text-muted"><Badge>{network.observed ? "Host policy observed" : "Host policy not observed"}</Badge><span>{network.note}</span></div><div className="divide-y divide-border rounded-xl border border-border">{network.rules.map((rule) => <div key={rule.id} className="flex flex-wrap items-center gap-2 px-3 py-2"><StateBadge state={rule.effect} /><code className="min-w-0 flex-1 break-all text-sm">{rule.destination}</code><span className="text-xs text-muted">{date(rule.createdAt)}</span><Button size="icon-sm" variant="ghost" aria-label={`Remove ${rule.effect} rule for ${rule.destination}`} disabled={actionDisabled} onClick={() => void submit({ action: "network-remove", ownerId: rule.ownerId, ruleId: rule.id })}><Trash2 aria-hidden className="h-4 w-4" /></Button></div>)}{!network.rules.length && <p className="p-4 text-sm text-muted">No owner-specific rules. Host defaults still apply.</p>}</div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end"><Field label="Check a destination"><Input aria-invalid={!!checkDestination.trim() && !validDestination(checkDestination)} aria-describedby="network-check-error" value={checkDestination} onChange={(event) => setCheckDestination(event.target.value)} placeholder="calendar.example.com" /></Field><Button variant="outline" disabled={actionDisabled || !selectedOwner || !validDestination(checkDestination)} onClick={() => void submit({ action: "network-check", ownerId: selectedOwner, destination: checkDestination })}>Check policy</Button></div>{!!checkDestination.trim() && !validDestination(checkDestination) && <p id="network-check-error" role="alert" className="text-xs text-danger">Enter a hostname or IPv4 address, optionally with a port from 1 to 65535.</p>}
        {networkCheck && <p role="status" className="rounded-xl bg-surface-2 px-3 py-2 text-sm"><span className="font-medium">{networkCheck.destination}</span>: {networkCheck.decision}. {networkCheck.detail}</p>}
        <div><h4 className="mb-2 text-sm font-medium">Recent network events</h4>{!network.eventsObserved ? <p className="text-sm text-muted">Network activity unavailable because the host response was not verified.</p> : network.events.length ? <div className="divide-y divide-border rounded-xl border border-border">{network.events.map((event, index) => <div key={`${event.at}-${event.destination}-${index}`} className="grid gap-1 px-3 py-2 text-sm sm:grid-cols-[160px_1fr_auto]"><span className="text-xs text-muted">{date(event.at)}</span><code className="break-all">{event.destination}</code><StateBadge state={event.decision} /></div>)}</div> : <p className="text-sm text-muted">No recent network events.</p>}</div></>}
      </Card>
    </section>}
    {tab === "resources" && <section {...panelProps("resources")} className="mt-5 space-y-4 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-fg/30">
      <Card className="space-y-4"><div><h3 className="font-medium">Defaults for new computers</h3><p className="mt-1 text-sm text-muted">These limits apply when a computer is provisioned. Saving them does not resize active computers.</p></div><div className="grid gap-3 sm:grid-cols-3"><Field label="CPU cores"><Input type="number" min={1} max={64} step={1} aria-invalid={!validInteger(cpus, 1, 64)} aria-describedby="resource-limit-error" value={cpus} onChange={(event) => setCpus(event.target.value)} /></Field><Field label="Memory (MB)"><Input type="number" min={512} max={65536} step={1} aria-invalid={!validInteger(memoryMb, 512, 65536)} aria-describedby="resource-limit-error" value={memoryMb} onChange={(event) => setMemoryMb(event.target.value)} /></Field><Field label="Maximum running"><Input type="number" min={1} max={1000} step={1} aria-invalid={!validInteger(maxRunning, 1, 1000)} aria-describedby="resource-limit-error" value={maxRunning} onChange={(event) => setMaxRunning(event.target.value)} /></Field></div>{(!validInteger(cpus, 1, 64) || !validInteger(memoryMb, 512, 65536) || !validInteger(maxRunning, 1, 1000)) && <p id="resource-limit-error" role="alert" className="text-sm text-danger">Enter whole numbers within the allowed limits: CPU 1–64, memory 512–65,536 MB, and maximum running 1–1,000.</p>}<div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">Current defaults: {data.settings.cpus} CPU · {humanMemory(data.settings.memoryMb)} memory · {data.settings.maxRunning} running.</p><Button disabled={actionDisabled || !data.settings.defaultTemplate || !resourcesValid} title={!data.settings.defaultTemplate ? "Set a default approved template first." : !resourcesValid ? "Correct the resource limits first." : undefined} onClick={() => void submit({ action: "settings", revision: data.settings.revision, cpus: Number(cpus), memoryMb: Number(memoryMb), maxRunning: Number(maxRunning), defaultTemplate: data.settings.defaultTemplate })}>Save resource defaults</Button></div>{!data.settings.defaultTemplate && <p className="text-xs text-muted">Choose and save a default approved template in Templates before saving resource defaults.</p>}</Card>
      <Card className="space-y-3"><h3 className="font-medium">Capacity and running computers</h3><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-surface-2 p-3"><p className="text-xs text-muted">Running</p><p className="mt-1 text-xl font-semibold tabular-nums">{data.runtimes.filter((runtime) => runtime.state === "running").length}</p></div><div className="rounded-xl bg-surface-2 p-3"><p className="text-xs text-muted">Configured maximum</p><p className="mt-1 text-xl font-semibold tabular-nums">{data.settings.maxRunning}</p></div><div className="rounded-xl bg-surface-2 p-3"><p className="text-xs text-muted">Admitted owners</p><p className="mt-1 text-xl font-semibold tabular-nums">{enabledRuntimes.length}</p></div></div></Card>
    </section>}
    {tab === "access" && <section {...panelProps("access")} className="mt-5 space-y-4 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-fg/30">
      <Card className="space-y-4"><div><h3 className="font-medium">Owner enrollment</h3><p className="mt-1 text-sm text-muted">Admitting a person lets them use an isolated computer with this default template. Disabled accounts cannot be enrolled.</p></div>
        {data.people.length ? <div className="divide-y divide-border rounded-xl border border-border">{data.people.map((person) => { const runtime = data.runtimes.find((entry) => entry.ownerId === person.id); const admitted = runtime?.admitted ?? data.settings.admittedOwners.includes(person.id); return <div key={person.id} className="flex flex-wrap items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{person.name}{person.disabled && <span className="ml-2 text-xs text-muted">Disabled</span>}</p><p className="truncate text-xs text-muted">{person.email}</p></div><StateBadge state={admitted ? "admitted" : "not enrolled"} /><Button size="sm" variant={admitted ? "outline" : "secondary"} disabled={actionDisabled || (!admitted && person.disabled) || busy} title={!admitted && person.disabled ? "Disabled accounts cannot be enrolled." : undefined} onClick={() => void submit({ action: "enrollment", revision: data.settings.revision, ownerId: person.id, admitted: !admitted })}>{admitted ? "Remove access" : "Admit owner"}</Button></div>; })}</div> : <p className="text-sm text-muted">No eligible people were found.</p>}
      </Card>
      <Card className="space-y-4"><div><h3 className="font-medium">Computer readiness evidence</h3><p className="mt-1 text-sm text-muted">Record operator-verified manual checks and link to evidence. These records are separate from sign-in verification and never enable the SIWC gate.</p></div><div className="grid gap-3 sm:grid-cols-3"><Field label="Area"><Select value={validationId} onChange={(event) => setValidationId(event.target.value as AdminValidation["id"])}>{Object.entries(CHECK_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</Select></Field><Field label="Result"><Select value={validationResult} onChange={(event) => setValidationResult(event.target.value as AdminValidation["result"])}><option value="passed">Passed</option><option value="failed">Failed</option><option value="pending">Pending</option></Select></Field><Field label="Evidence reference"><Input maxLength={300} aria-invalid={!!validationReference && !validValidationReference} aria-describedby="validation-reference-error" value={validationReference} onChange={(event) => setValidationReference(event.target.value)} placeholder="Runbook, ticket, or notes URL" /></Field></div>{!!validationReference && !validValidationReference && <p id="validation-reference-error" role="alert" className="text-xs text-danger">Use up to 300 characters without control characters.</p>}<Button disabled={actionDisabled || !validValidationReference} onClick={() => void submit({ action: "validation", revision: data.settings.revision, id: validationId, result: validationResult, reference: validationReference })}>Save operator validation</Button>
        <div><h4 className="mb-2 text-sm font-medium">Recorded operator checks</h4>{data.validation.length ? <div className="divide-y divide-border rounded-xl border border-border">{data.validation.map((item) => <div key={`${item.id}-${item.checkedAt}-${item.reference}`} className="flex flex-wrap items-start gap-2 px-3 py-3"><div className="min-w-0 flex-1"><p className="text-sm font-medium">{CHECK_LABELS[item.id] ?? item.id}</p><p className="mt-1 break-all text-xs text-muted">{item.reference}</p><p className="mt-1 text-xs text-subtle">{date(item.checkedAt)} · {item.checkedBy ?? "unknown operator"} · operator-recorded manual check</p></div><StateBadge state={item.result} /></div>)}</div> : <p className="text-sm text-muted">No manual validation has been recorded.</p>}</div>
      </Card>
      <Card className="space-y-3"><div><h3 className="font-medium">What readiness means</h3><p className="text-sm text-muted">Host checks confirm required software and isolation setup. Computer availability and session control are reported separately per owner. Enrollment does not verify an external identity or sign-in; record evidence here only after an operator completes the corresponding manual check.</p></div><div className="flex flex-wrap gap-2">{data.validation.map((item) => <span key={`${item.id}-${item.checkedAt}`} className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-xs"><span>{CHECK_LABELS[item.id]}</span><StateBadge state={item.result} /></span>)}</div></Card>
    </section>}

    <Dialog open={diagnosticDialog} onOpenChange={setDiagnosticDialog}>
      <DialogContent title="Sanitized host diagnostics" description="The report includes host readiness checks only. It does not include owner credentials, computer screenshots, or sign-in data." className="max-w-2xl">
        <div className="space-y-4">{diagnosticResult ? <><p className="text-xs text-muted">Captured {date(diagnosticResult.checkedAt)} · source: {diagnosticResult.source} · live computer use verified: no</p><CheckList checks={diagnosticResult.checks} /><div className="flex justify-end"><Button onClick={() => downloadDiagnostics({ message: "", diagnostics: diagnosticResult })}><ArrowDownToLine aria-hidden className="h-4 w-4" />Download report</Button></div></> : <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" />Collecting host checks…</div>}</div>
      </DialogContent>
    </Dialog>
    <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) { setDeleteTarget(null); setDeleteConfirmation(""); } }}>
      <DialogContent title="Delete computer and data?" description={`This permanently deletes ${deleteTarget?.name ?? "the selected owner's"} computer and its saved data. This cannot be undone.`}>
        <div className="space-y-4"><Field label="Type DELETE to confirm"><Input autoComplete="off" autoCapitalize="characters" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} /></Field><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="danger" disabled={busy || deleteConfirmation !== "DELETE" || !deleteTarget || !data.available} onClick={() => {
          if (!deleteTarget || deleteConfirmation !== "DELETE") return;
          void submit({ action: "lifecycle", ownerId: deleteTarget.ownerId, operation: "delete", confirmation: "DELETE" }).then((result) => {
            if (result) { setDeleteTarget(null); setDeleteConfirmation(""); }
          });
        }}>Delete computer</Button></div></div>
      </DialogContent>
    </Dialog>
  </div>;
}

function TemplateRow({ template, isDefault, disabled, onRemove }: { template: AdminTemplate; isDefault: boolean; disabled: boolean; onRemove: () => void }) {
  const availability = template.available === null ? "unknown" : template.available ? "available" : "missing";
  const removeReason = isDefault ? "This is the default template. Choose another default first." : template.inUse > 0 ? "This template is used by an existing computer." : "Remove template";
  return <div className="flex flex-wrap items-center gap-3 px-3 py-3"><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{template.label}</span><StateBadge state={availability} label={template.available === null ? "Availability unknown" : undefined} />{isDefault && <Badge tone="blue">Current default</Badge>}<Badge>{template.inUse} in use</Badge></div><code className="mt-1 block break-all text-xs text-muted">{template.reference}</code></div><Button size="icon-sm" variant="ghost" aria-label={`Remove approved template ${template.label}`} disabled={disabled || isDefault || template.inUse > 0} title={removeReason} onClick={onRemove}><Trash2 aria-hidden className="h-4 w-4" /></Button></div>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
