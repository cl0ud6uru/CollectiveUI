"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { approveExistingManagedHermesBot, createManagedHermesBot, registerHermesConnection, rotateHermesDashboardToken, restoreManagedHermesBot, toggleHermesConnection } from "@/app/admin/hermes/actions";
import { HERMES_PROTOCOL } from "@/lib/hermes-provisioning/config";
import { Badge, Card, Table, Td } from "@/components/admin/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = {
  users: { id: string; name: string; upn: string }[];
  connections: { id: string; userId: string; boundaryId: string; enabled: boolean; quota: number }[];
  profiles: { id: string; userId: string; botId: string; appId: string; profile: string; status: string; attempts: number; error: string | null }[];
  templates: { id: string; name: string; approvedBotId: string | null; provider: string | null; model: string | null; candidates: { id: string; name: string }[] }[];
  botNames: Record<string, string>;
};
const field = "w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none placeholder:text-subtle focus:border-fg/40";
const PROFILE_STATUS: Record<string, { label: string; tone: "default" | "green" | "red" | "amber" | "blue" }> = {
  ready: { label: "Ready", tone: "green" }, failed: { label: "Failed", tone: "red" },
  provisioning: { label: "Setting up", tone: "blue" }, pending: { label: "Waiting", tone: "amber" },
};

function Labeled({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return <label className={cn("block space-y-1.5", className)}><span className="block text-sm font-medium">{label}</span>{children}{hint && <span className="block text-xs text-muted">{hint}</span>}</label>;
}
function SectionHeader({ title, count, action }: { title: string; count?: number; action?: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <h2 className="flex items-baseline gap-2 text-lg font-semibold">{title}{count !== undefined && <span className="text-sm font-normal text-subtle tabular-nums">{count}</span>}</h2>
    {action}
  </div>;
}
function Providers() {
  return <><option>openai</option><option>anthropic</option><option>openrouter</option></>;
}

export function HermesAdmin({ users, connections, profiles, templates, botNames }: Props) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState<"runtime" | "definition" | null>(null);
  const perform = (fn: () => Promise<{ error?: string; ok?: boolean }>, form?: HTMLFormElement, close?: boolean) => start(async () => {
    setMessage("");
    try { const result = await fn(); setMessage(result.error ?? "Saved"); if (result.ok) { form?.reset(); if (close) setOpen(null); } }
    catch { setMessage("The request failed. Reload and check its status before retrying."); }
  });
  const person = (id: string) => users.find((u) => u.id === id)?.name ?? id;
  const displayName = (t: Props["templates"][number]) => (t.approvedBotId && botNames[t.approvedBotId]) || t.name.replace(/ · private Hermes profiles$/, "");

  return <div className="space-y-10">
    <Card className="space-y-2 border-amber-500/40 bg-amber-500/5 text-sm">
      <p className="font-medium">Advanced setup for operators</p>
      <p className="text-muted">Hermes is single-tenant. Profiles organize state; they do not isolate users. Register a runtime only after an operator has given that person their own isolated Hermes. This page records its endpoints and keys; it doesn&apos;t create containers, tunnels or proxies.</p>
      <details>
        <summary className="cursor-pointer font-medium">Operator requirements</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
          <li>A separate Hermes process tree, filesystem, credentials and network policy for each person. No host Docker socket is needed.</li>
          <li>Separate loopback tunnels for the dashboard and the multiplexed Runs listener, on matching ports in every web and worker network namespace. The dashboard keeps its loopback session-token gate; a remote cookie-auth dashboard won&apos;t work.</li>
          <li>Dashboard access limited to CollectiveUI operators and unreachable from agent tools. The dashboard token stays out of agent access.</li>
          <li>Provider and profile keys are installed inside that person&apos;s runtime, supplied by your operator.</li>
          <li>Supported contract: <code className="break-all">{HERMES_PROTOCOL}</code>. Pin the deployed source revision and enter its exact health version values. Remote dashboard authentication and skill installation aren&apos;t supported.</li>
        </ul>
      </details>
    </Card>

    <p role="status" aria-live="polite" className={cn("text-sm", !pending && !message && "sr-only")}>{pending ? "Saving…" : message}</p>

    <section className="space-y-4">
      <SectionHeader title="Runtimes" count={connections.length} action={open !== "runtime" && <Button size="sm" onClick={() => setOpen("runtime")}><Plus className="h-4 w-4" aria-hidden="true" /> Add runtime</Button>} />
      {open === "runtime" && <Card>
        <form className="space-y-5" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
          perform(() => registerHermesConnection(data), form, true);
        }}>
          <h3 className="font-semibold">Register a user runtime</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Labeled label="User"><select name="userId" required defaultValue="" className={field}><option value="" disabled>Select the runtime owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.upn})</option>)}</select></Labeled>
            <Labeled label="Operator isolation boundary ID"><input className={field} name="boundaryId" required autoComplete="off" /></Labeled>
            <Labeled label="Dashboard loopback origin"><input className={field} name="dashboardUrl" required autoComplete="off" placeholder="http://127.0.0.1:19100" /></Labeled>
            <Labeled label="Runs loopback origin"><input className={field} name="runsUrl" required autoComplete="off" placeholder="http://127.0.0.1:19101" /></Labeled>
            <Labeled label="Exact Hermes version"><input className={field} name="expectedVersion" required autoComplete="off" /></Labeled>
            <Labeled label="Exact Hermes displayVersion"><input className={field} name="expectedDisplayVersion" required autoComplete="off" /></Labeled>
            <Labeled label="Dashboard session token"><input type="password" className={field} name="dashboardToken" required autoComplete="new-password" /></Labeled>
            <Labeled label="Provider"><select className={field} name="provider"><Providers /></select></Labeled>
            <Labeled label="Provider API key" className="sm:col-span-2"><input type="password" className={field} name="providerKey" required autoComplete="new-password" /></Labeled>
            <Labeled label="Distinct profile API keys (one per line)" className="sm:col-span-2" hint="Each key reserves room for one bot. Failed profiles keep their slot and memory. Keys are encrypted on save and never shown again.">
              <textarea className={field} name="profileKeys" required rows={3} autoComplete="off" spellCheck={false} />
            </Labeled>
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="isolated" required className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--fg)]" />I verified whole-process and filesystem isolation for this user, pinned the supported source, and blocked agent access to administration.</label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
            <Button type="submit" disabled={pending}>Register runtime</Button>
          </div>
        </form>
      </Card>}
      {connections.length ? <Table head={["Owner", "Isolation boundary", "Status", "Profiles", ""]}>
        {connections.map((c) => {
          const used = profiles.filter((p) => p.userId === c.userId).length;
          return <tr key={c.id} className="align-top">
            <Td className="font-medium">{person(c.userId)}</Td>
            <Td className="break-all font-mono text-xs">{c.boundaryId}</Td>
            <Td><Badge tone={c.enabled ? "green" : "default"}>{c.enabled ? "Enabled" : "Disabled"}</Badge></Td>
            <Td className="tabular-nums">{used} of {c.quota}</Td>
            <Td className="min-w-64">
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" size="sm" disabled={pending} onClick={() => perform(() => toggleHermesConnection(c.id, !c.enabled))}>{c.enabled ? "Disable runtime" : "Enable runtime"}</Button>
              </div>
              <details className="mt-2 text-right">
                <summary className="cursor-pointer text-xs text-muted hover:text-fg">Replace dashboard token</summary>
                <form className="mt-2 flex gap-2 text-left" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); data.set("id", c.id); perform(() => rotateHermesDashboardToken(data), form); }}>
                  <input name="token" type="password" required className={field} autoComplete="new-password" aria-label="Replacement dashboard token" placeholder="New token" />
                  <Button type="submit" size="sm" variant="secondary" className="h-auto" disabled={pending}>Replace</Button>
                </form>
              </details>
            </Td>
          </tr>;
        })}
      </Table> : <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No runtimes registered. People can&apos;t set up managed profiles until one is.</p>}
    </section>

    <section className="space-y-4">
      <SectionHeader title="Shared bot definitions" count={templates.length} action={open !== "definition" && <Button size="sm" onClick={() => setOpen("definition")}><Plus className="h-4 w-4" aria-hidden="true" /> New definition</Button>} />
      <p className="max-w-3xl text-sm text-muted">A definition is a bot everyone can use. Each person&apos;s first message creates their own blank profile from it: instructions are copied, but memory, sessions and credentials never are. Direct chats only. A definition is frozen once a profile uses it.</p>
      {open === "definition" && <Card>
        <form className="space-y-5" onSubmit={(e) => {
          e.preventDefault(); const form = e.currentTarget; const data = new FormData(form);
          perform(() => createManagedHermesBot({ name: data.get("name"), instructions: data.get("instructions"), config: { provider: data.get("provider"), model: data.get("model"), skills: [], toolsets: String(data.get("toolsets")).split(/[,\s]+/).filter(Boolean) } }), form, true);
        }}>
          <h3 className="font-semibold">Create a shared bot definition</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <Labeled label="Bot name" className="sm:col-span-2"><input className={field} name="name" required maxLength={80} /></Labeled>
            <Labeled label="Instructions" className="sm:col-span-2"><textarea className={field} name="instructions" required rows={4} maxLength={20000} /></Labeled>
            <Labeled label="Model provider"><select className={field} name="provider"><Providers /></select></Labeled>
            <Labeled label="Native model ID"><input className={field} name="model" required /></Labeled>
            <Labeled label="Enabled Hermes toolsets (comma separated)" className="sm:col-span-2" hint="Leave blank for none. Skills start empty. Toolsets are configuration, not a security boundary. /new keeps the profile and its memory but starts a fresh session.">
              <input className={field} name="toolsets" />
            </Labeled>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(null)}>Cancel</Button>
            <Button type="submit" disabled={pending}>Create managed bot</Button>
          </div>
        </form>
      </Card>}
      {templates.length ? <ul className="space-y-3">{templates.map((t) => {
        const used = profiles.filter((p) => p.appId === t.id).length;
        return <li key={t.id}><Card className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-medium">{displayName(t)}</span>
            <Badge tone={t.approvedBotId ? "green" : "amber"}>{t.approvedBotId ? "Approved" : "Approval required"}</Badge>
            <span className="text-sm text-muted">{[t.provider, t.model].filter(Boolean).join(" · ")}</span>
            <span className="ml-auto text-sm text-muted tabular-nums">{used} {used === 1 ? "profile" : "profiles"}</span>
          </div>
          {!t.approvedBotId && <form className="space-y-2 rounded-xl bg-surface-2 p-3" onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); perform(() => approveExistingManagedHermesBot(t.id, String(data.get("botId")))); }}>
            <p className="text-sm">Review the original bot&apos;s definition, then approve it. Approval keeps its existing profiles and lets first-use setup continue. Conflicting retained assignments need an operator to reconcile.</p>
            <div className="flex flex-wrap items-end gap-2">
              <Labeled label="Existing bot" className="min-w-56 flex-1"><select name="botId" required className={field} defaultValue=""><option value="" disabled>Select the original bot</option>{t.candidates.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Labeled>
              <Button type="submit" size="sm" className="h-10" disabled={pending}>Approve existing managed bot</Button>
            </div>
          </form>}
          <details className="text-sm">
            <summary className="cursor-pointer text-muted hover:text-fg">Restore a previously assigned definition</summary>
            <p className="mt-2 text-muted">Only for a definition edited before freezing was enforced. Enter the original text from your records. It restores and approves only if it matches every retained profile; no profile, session or memory is replaced.</p>
            <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); data.set("appId", t.id); perform(() => restoreManagedHermesBot(data), form); }}>
              <Labeled label="Original bot"><select className={field} name="botId" required defaultValue={t.approvedBotId ?? ""}><option value="" disabled>Select the original bot</option>{t.candidates.filter((b) => !t.approvedBotId || b.id === t.approvedBotId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Labeled>
              <Labeled label="Original name"><input className={field} name="name" required maxLength={100} /></Labeled>
              <Labeled label="Original description" className="sm:col-span-2"><textarea className={field} name="description" maxLength={2000} /></Labeled>
              <Labeled label="Original instructions" className="sm:col-span-2"><textarea className={field} name="instructions" maxLength={24000} /></Labeled>
              <Labeled label="Original boundaries" className="sm:col-span-2"><textarea className={field} name="boundaries" maxLength={5000} /></Labeled>
              <div className="sm:col-span-2"><Button type="submit" variant="outline" size="sm" disabled={pending}>Verify and restore original definition</Button></div>
            </form>
          </details>
        </Card></li>;
      })}</ul> : <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No shared definitions yet.</p>}
    </section>

    <section className="space-y-4">
      <SectionHeader title="Profiles" count={profiles.length} />
      {profiles.length ? <Table head={["Person", "Bot", "Profile", "Status", "Attempts"]}>
        {profiles.map((p) => {
          const status = PROFILE_STATUS[p.status] ?? { label: p.status, tone: "default" as const };
          return <tr key={p.id} className="align-top">
            <Td className="font-medium">{person(p.userId)}</Td>
            <Td>{botNames[p.botId] ?? <span className="text-subtle">Deleted bot</span>}</Td>
            <Td className="font-mono text-xs">{p.profile}</Td>
            <Td className="min-w-48"><Badge tone={status.tone}>{status.label}</Badge>{p.error && <p className="mt-1 text-xs text-danger">{p.error}</p>}</Td>
            <Td className="tabular-nums">{p.attempts}</Td>
          </tr>;
        })}
      </Table> : <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">No profiles yet. One is created the first time a person messages a shared definition.</p>}
    </section>
  </div>;
}
