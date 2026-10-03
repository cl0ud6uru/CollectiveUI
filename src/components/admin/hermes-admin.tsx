"use client";

import { useState, useTransition } from "react";
import { approveExistingManagedHermesBot, createManagedHermesBot, registerHermesConnection, rotateHermesDashboardToken, restoreManagedHermesBot, toggleHermesConnection } from "@/app/admin/hermes/actions";
import { HERMES_PROTOCOL } from "@/lib/hermes-provisioning/config";

type Props = {
  users: { id: string; name: string; upn: string }[];
  connections: { id: string; userId: string; boundaryId: string; enabled: boolean; quota: number }[];
  profiles: { id: string; userId: string; botId: string; profile: string; status: string; attempts: number; error: string | null }[];
  templates: { id: string; name: string; approvedBotId: string | null; candidates: { id: string; name: string }[] }[];
};
const field = "w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm";
export function HermesAdmin({ users, connections, profiles, templates }: Props) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState("");
  const perform = (fn: () => Promise<{ error?: string; ok?: boolean }>, form?: HTMLFormElement) => start(async () => {
    setMessage("");
    try { const result = await fn(); setMessage(result.error ?? "Saved"); if (result.ok) form?.reset(); }
    catch { setMessage("The request failed. Reload and check its status before retrying."); }
  });
  return <div className="max-w-4xl space-y-8 p-6">
    <div className="rounded-xl border border-border p-4 text-sm space-y-2">
      <p>Hermes is single-tenant. Profiles organize state; they do not isolate users.</p>
      <p>Before registering, provide a separate whole Hermes process tree, filesystem, credentials and network policy for each user. Restrict dashboard access to CollectiveUI operators and keep it unreachable from agent tools. No host Docker socket is required or accessed here.</p>
      <p>Use separate operator-controlled loopback tunnels for the dashboard and multiplexed Runs listener, with matching ports in every web/worker network namespace. The protected dashboard must retain its loopback session-token gate; a remote cookie-auth dashboard is not compatible. This screen registers endpoints; it does not create tunnels, sidecars, proxies or containers.</p>
      <p>Provider and profile keys are installed inside that user’s runtime. The distinct dashboard token must remain outside agent access. Your operator must supply these keys and the protected forwarding/isolation setup before registration.</p>
      <p>Supported contract: {HERMES_PROTOCOL}. Pin the deployed source revision and enter its exact health version values. Remote dashboard authentication and skill installation are not supported.</p>
    </div>
    <p role="status" aria-live="polite">{pending ? "Saving…" : message}</p>
    <form className="space-y-3" onSubmit={(event) => {
      event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
      perform(() => registerHermesConnection(data), form);
    }}>
      <h2 className="text-lg font-semibold">Register a user runtime</h2>
      <label className="block">User<select name="userId" required defaultValue="" className={field}><option value="" disabled>Select the runtime owner</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.upn})</option>)}</select></label>
      {[ ["boundaryId", "Operator isolation boundary ID"], ["dashboardUrl", "Dashboard loopback origin"], ["runsUrl", "Runs loopback origin"], ["expectedVersion", "Exact Hermes version"], ["expectedDisplayVersion", "Exact Hermes displayVersion"] ].map(([name, label]) =>
        <label className="block" key={name}>{label}<input className={field} name={name} required autoComplete="off" /></label>)}
      <label className="block">Dashboard session token<input type="password" className={field} name="dashboardToken" required autoComplete="new-password" /></label>
      <label className="block">Provider<select className={field} name="provider"><option>openai</option><option>anthropic</option><option>openrouter</option></select></label>
      <label className="block">Provider API key<input type="password" className={field} name="providerKey" required autoComplete="new-password" /></label>
      <label className="block">Distinct profile API keys (one per line)<textarea className={field} name="profileKeys" required rows={3} autoComplete="off" spellCheck={false} /></label>
      <p className="text-sm text-muted">Each key reserves capacity for one bot. Failed profiles retain their slot and memory. Keys are encrypted on save and never returned to this page.</p>
      <label className="flex gap-2"><input type="checkbox" name="isolated" required />I verified whole-process and filesystem isolation for this user, pinned the supported source, and blocked agent access to administration.</label>
      <button className={field} disabled={pending}>Register runtime</button>
    </form>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Registered runtimes</h2>
      {connections.length === 0 && <p>No runtimes registered. Users cannot provision profiles yet.</p>}
      {connections.map((c) => <div key={c.id} className="rounded-xl border border-border p-4 space-y-2">
        <p>{users.find((u) => u.id === c.userId)?.name ?? c.userId} · {c.boundaryId} · {c.enabled ? "Enabled" : "Disabled"} · {profiles.filter((p) => p.userId === c.userId).length}/{c.quota} slots</p>
        <button disabled={pending} className={field} onClick={() => perform(() => toggleHermesConnection(c.id, !c.enabled))}>{c.enabled ? "Disable runtime" : "Enable runtime"}</button>
        <form onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); data.set("id", c.id); perform(() => rotateHermesDashboardToken(data), form); }}>
          <label>Replacement dashboard token<input name="token" type="password" required className={field} autoComplete="new-password" /></label>
          <button disabled={pending} className={field}>Replace dashboard token</button>
        </form>
      </div>)}
    </section>
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault(); const form = e.currentTarget; const data = new FormData(form);
      perform(() => createManagedHermesBot({ name: data.get("name"), instructions: data.get("instructions"), config: { provider: data.get("provider"), model: data.get("model"), skills: [], toolsets: String(data.get("toolsets")).split(/[,\s]+/).filter(Boolean) } }), form);
    }}>
      <h2 className="text-lg font-semibold">Create a shared bot definition</h2>
      <p className="text-sm text-muted">Each person’s first message creates their own blank profile. Instructions are copied; memories, sessions and credentials are never cloned. Direct chats only. Definitions are frozen once a profile is assigned.</p>
      <label className="block">Bot name<input className={field} name="name" required maxLength={80} /></label>
      <label className="block">Instructions<textarea className={field} name="instructions" required rows={4} maxLength={20000} /></label>
      <label className="block">Model provider<select className={field} name="provider"><option>openai</option><option>anthropic</option><option>openrouter</option></select></label>
      <label className="block">Native model ID<input className={field} name="model" required /></label>
      <label className="block">Enabled Hermes toolsets (comma separated)<input className={field} name="toolsets" /></label>
      <p className="text-sm text-muted">Skills start empty. Blank toolsets means none. Tool choices are configuration, not a security boundary. /new retains this profile and memory while starting a fresh session.</p>
      <button disabled={pending} className={field}>Create managed bot</button>
    </form>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Managed definitions</h2>{templates.map((t) => <div key={t.id} className="rounded-xl border border-border p-3">
      <p>{t.name} · {t.approvedBotId ? "Approved" : "Approval required"}</p>
      {!t.approvedBotId && <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); perform(() => approveExistingManagedHermesBot(t.id, String(data.get("botId")))); }}>
        <p>Choose the original bot after reviewing its definition. Approval preserves its existing profiles and permits first-use provisioning. Conflicting retained assignments require operator reconciliation.</p>
        <label>Existing bot<select name="botId" required className={field} defaultValue=""><option value="" disabled>Select the original bot</option>{t.candidates.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <button disabled={pending} className={field}>Approve existing managed bot</button>
      </form>}
      <details className="mt-2"><summary>Restore a previously assigned definition</summary>
        <p className="text-sm text-muted">For a definition edited before freezing was enforced, enter the original text from your records. Restoration and approval succeed only if it matches every retained profile assignment. No profile, session or memory is replaced.</p>
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); data.set("appId", t.id); perform(() => restoreManagedHermesBot(data), form); }}>
          <label>Original bot<select className={field} name="botId" required defaultValue={t.approvedBotId ?? ""}><option value="" disabled>Select the original bot</option>{t.candidates.filter((b) => !t.approvedBotId || b.id === t.approvedBotId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label>Original name<input className={field} name="name" required maxLength={100} /></label>
          <label>Original description<textarea className={field} name="description" maxLength={2000} /></label>
          <label>Original instructions<textarea className={field} name="instructions" maxLength={24000} /></label>
          <label>Original boundaries<textarea className={field} name="boundaries" maxLength={5000} /></label>
          <button disabled={pending} className={field}>Verify and restore original definition</button>
        </form>
      </details>
    </div>)}</section>
    <section className="space-y-3"><h2 className="text-lg font-semibold">Profile setup status</h2>
      {profiles.length === 0 && <p>No profiles assigned yet.</p>}
      {profiles.map((p) => <div key={p.id} className="rounded-xl border border-border p-3"><p>{users.find((u) => u.id === p.userId)?.name ?? p.userId} · {p.profile} · {p.status} · {p.attempts} attempts</p>{p.error && <p>{p.error}</p>}</div>)}
    </section>
  </div>;
}
