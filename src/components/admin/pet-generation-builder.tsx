"use client";
import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { PetGenerationSettings } from "@/lib/settings";
import type { PetManifest } from "@/lib/pets/shared";
import { petControl } from "@/components/pets/pet-upload";
import { PetPreview } from "@/components/pets/pet-preview";

type Connection = { id: string; name: string; provider: string; baseUrl: string | null; enabled: boolean };
type Job = {
  id: string; displayName: string; description: string; credit: string; appearanceState: string; appearanceConsentAt: string | null;
  appearanceApprovedAt: string | null; buildConsentAt: string | null; hasAppearance: boolean; hasPreview: boolean; previewErrorCode: string | null; catalogPetId: string | null;
  slots: { slotKey: string; attempt: number; status: string; inputTokens: number | null; outputTokens: number | null; costMicros: number | null; errorCode: string | null; consentVersion: number; consentSummary: string; updatedAt: string; isLatest: boolean }[];
};
type SettingsPayload = { settings: PetGenerationSettings; connections: Connection[] };
type BuilderInitial = SettingsPayload & { memberMode?: boolean; allowed?: boolean; assignableBots?: { id: string; name: string }[] };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json();
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Pet generation request failed.");
  return body as T;
}
async function fileBase64(file: File) {
  if (file.size > 1024 * 1024) throw new Error("Reference image must be 1 MB or smaller.");
  let binary = "";
  for (const byte of new Uint8Array(await file.arrayBuffer())) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function PetGenerationBuilder({ initial }: { initial: BuilderInitial }) {
  const router = useRouter();
  const memberMode = initial.memberMode === true;
  const collection = "/api/pets/generation";
  const detail = (jobId: string) => `${collection}/${encodeURIComponent(jobId)}`;
  const [settings, setSettings] = useState(initial.settings);
  const [enabled, setEnabled] = useState(initial.settings.enabled);
  const [connectionId, setConnectionId] = useState(initial.settings.providerConnectionId ?? "");
  const [access, setAccess] = useState(initial.settings.access);
  const [groupIds, setGroupIds] = useState(initial.settings.allowedGroupIds.join("; "));
  const [upns, setUpns] = useState(initial.settings.allowedUpns.join("; "));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [credit, setCredit] = useState("AI generated with OpenAI");
  const [reference, setReference] = useState<File | null>(null);
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobs, setJobs] = useState<{ id: string; displayName: string; appearanceState: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [appearanceConsent, setAppearanceConsent] = useState(false);
  const [buildConsent, setBuildConsent] = useState(false);
  const [shareRights, setShareRights] = useState(false);
  const [visualReview, setVisualReview] = useState(false);
  const [assignBotId, setAssignBotId] = useState(initial.assignableBots?.[0]?.id ?? "");

  async function refreshList() { setJobs(await api(collection)); }
  async function refreshJob(id = jobId) { if (id) setJob(await api<Job>(detail(id))); }
  useEffect(() => {
    if (memberMode && initial.allowed === false) return;
    let active = true;
    void api<{ id: string; displayName: string; appearanceState: string }[]>(collection)
      .then(rows => { if (active) setJobs(rows); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [collection, memberMode, initial.allowed]);
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    void api<Job>(`${collection}/${encodeURIComponent(jobId)}`).then(value => { if (active) setJob(value); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [collection, jobId]);

  async function saveSettings() {
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await api<PetGenerationSettings & { updatedBy: string }>("/api/admin/pets/generation/settings", { method: "PATCH", body: JSON.stringify({
        enabled, providerConnectionId: connectionId || null, access,
        allowedGroupIds: groupIds.split(/[;\n]/).map(value => value.trim()).filter(Boolean),
        allowedUpns: upns.split(/[;\n]/).map(value => value.trim().toLowerCase()).filter(Boolean),
      }) });
      setSettings(next); setNotice("Pet generation settings saved.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not save settings."); }
    finally { setBusy(false); }
  }

  async function createJob(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!description.trim() && !reference) { setError("Provide an appearance description or choose a reference image."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const referenceBase64 = reference ? await fileBase64(reference) : undefined;
      const created = await api<{ id: string }>(collection, { method: "POST", body: JSON.stringify({ displayName: name, description, credit, ...(referenceBase64 ? { referenceBase64 } : {}) }) });
      setJob(null); setJobId(created.id); setName(""); setDescription(""); setReference(null); setAppearanceConsent(false); setBuildConsent(false); setShareRights(false);
      await refreshList(); setNotice("Private draft created. Generate the appearance only after reviewing the cost and consent below.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create the draft."); }
    finally { setBusy(false); }
  }

  async function action(body: Record<string, unknown>, message: string) {
    if (!jobId || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api(detail(jobId), { method: "POST", body: JSON.stringify(body) });
      if (body.action === "appearance" || body.action === "retryAppearance") setAppearanceConsent(false);
      if (body.action === "build") setBuildConsent(false);
      if (body.action === "preview" || body.action === "assignPrivate") { setVisualReview(false); setShareRights(false); }
      await refreshJob(); await refreshList(); setNotice(message);
      if (body.action === "save" || body.action === "assignPrivate") router.refresh();
    } catch (err) { await refreshJob().catch(() => undefined); setError(err instanceof Error ? err.message : "Pet generation request failed."); }
    finally { setBusy(false); }
  }

  async function runQueued() {
    if (!jobId || busy || !job) return;
    setBusy(true); setError(""); setNotice("");
    try {
      for (const slot of job.slots) if (slot.status === "queued") {
        await api(detail(jobId), { method: "POST", body: JSON.stringify({ action: "slot", slotKey: slot.slotKey }) });
        await refreshJob();
      }
      await refreshJob(); await refreshList(); setNotice("Queued sprite requests finished. Review every cell in the validated preview before saving.");
    } catch (err) { await refreshJob().catch(() => undefined); setError(err instanceof Error ? err.message : "A sprite request needs attention."); }
    finally { setBusy(false); }
  }

  async function retry(slotKey: string, replacingSuccessful = false) {
    const reason = replacingSuccessful ? `Replace the successful ${slotKey} state because it looks unsatisfactory` : `Retry the failed or uncertain ${slotKey} state`;
    if (!window.confirm(`${reason}. This creates a new paid image request; the previous request may also have incurred cost. Usage varies with no fixed quote or hard cap. Authorize this additional request?`)) return;
    await action({ action: "retry", slotKey, consent: true }, `${replacingSuccessful ? "Replacement" : "Retry"} for ${slotKey} queued. Start queued requests when ready.`);
  }

  return <section className="space-y-4 rounded-xl border border-border p-4">
    <div><h2 className="font-medium">{memberMode ? "AI-assisted private pet" : "AI-assisted pet builder · administrator settings"}</h2><p className="mt-1 text-sm text-muted">{memberMode ? "Your generated assets and receipts stay private. Assign a reviewed v2 pet only to a private caller bot you can use." : "Creates private generation receipts and an unpublished catalog draft. Provider setup and group access are controlled here; every paid stage requires per-user consent."}</p></div>
    {!memberMode && <>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">Saved official OpenAI connection<select className={petControl} value={connectionId} onChange={event => setConnectionId(event.target.value)}><option value="">Choose connection</option>{initial.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /> Enable paid image generation (default off)</label>
      <label className="grid gap-1 text-sm">User access<select className={petControl} value={access} onChange={event => setAccess(event.target.value as "selected" | "everyone")}><option value="selected">Selected users/groups</option><option value="everyone">Everyone</option></select></label>
      <label className="grid gap-1 text-sm">Allowed portal group IDs<input className={petControl} value={groupIds} onChange={event => setGroupIds(event.target.value)} placeholder="group-id; another-id" /></label>
      <label className="grid gap-1 text-sm sm:col-span-2">Allowed user UPNs<input className={petControl} value={upns} onChange={event => setUpns(event.target.value)} placeholder="person@example.org; another@example.org" /></label>
    </div>
    <p className="text-xs text-muted">Only a saved, enabled OpenAI connection using the official endpoint and the documented model <code>gpt-image-2.5-sunburst</code> is accepted. No custom URL or credential is accepted.</p>
    <button type="button" className={petControl} disabled={busy || !connectionId} onClick={() => void saveSettings()}>{busy ? "Saving…" : "Save generation settings"}</button></>}
    <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer font-medium">Published cost basis and limits</summary><p className="mt-2 text-sm text-muted">The official model page lists separate image-input and image-output token rates ($8 and $30 per million respectively; text input is priced separately). Total cost varies with token use; there is no fixed quote or hard cap in this workflow. Each image call is one request with automatic retries disabled. Review the <a className="underline" href="https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst" target="_blank" rel="noreferrer">official model page</a> and <a className="underline" href="https://developers.openai.com/api/docs/guides/image-generation" target="_blank" rel="noreferrer">image guide</a>.</p></details>
    {settings.enabled && <>
      <hr className="border-border" />
      <form className="grid gap-3" onSubmit={createJob}>
        <h3 className="font-medium">Start a private draft</h3>
        <label className="grid gap-1 text-sm">Pet name<input className={petControl} maxLength={80} required value={name} onChange={event => setName(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">Appearance description (optional when a reference image is supplied)<textarea className={petControl} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">Artwork credit<input className={petControl} maxLength={240} value={credit} onChange={event => setCredit(event.target.value)} /></label>
        <label className="grid gap-1 text-sm">Reference image (optional when a description is supplied; static PNG/JPEG/WebP, up to 1 MB)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => setReference(event.target.files?.[0] ?? null)} /></label>
        <button className={petControl} disabled={busy || !settings.enabled}>{busy ? "Working…" : "Create private generation draft"}</button>
      </form>
      <label className="grid gap-1 text-sm">Draft to continue<select className={petControl} value={jobId} onChange={event => { setJob(null); setVisualReview(false); setShareRights(false); setJobId(event.target.value); }}><option value="">Choose a draft</option>{jobs.map(row => <option key={row.id} value={row.id}>{row.displayName} · {row.appearanceState}</option>)}</select></label>
      {job && <div className="space-y-3 rounded-lg border border-border p-3">
        <h3 className="font-medium">{job.displayName} · {job.appearanceState}</h3>
        {job.slots.filter(slot => slot.slotKey === "appearance").map(slot => <div key={`appearance:${slot.attempt}`} className="text-xs text-muted"><p>Appearance attempt {slot.attempt}: {slot.status}{slot.inputTokens !== null || slot.outputTokens !== null ? ` · ${slot.inputTokens ?? "?"} input / ${slot.outputTokens ?? "?"} output tokens` : ""}{slot.costMicros === null ? " · exact cost unavailable" : ` · ${slot.costMicros} micro-USD reported`}</p><details><summary>Consent receipt v{slot.consentVersion}</summary><p>{slot.consentSummary}</p></details></div>)}
        {job.hasAppearance && <Image unoptimized width={1024} height={1024} className="max-h-72 rounded-lg border border-border bg-muted object-contain" src={`${detail(job.id)}/image?kind=appearance`} alt={`Generated appearance concept for ${job.displayName}`} />}
        {job.appearanceState === "needs_consent" && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={appearanceConsent} onChange={event => setAppearanceConsent(event.target.checked)} />I authorize one appearance-generation request at the published variable token rates described above.</label><button className={petControl} disabled={busy || !appearanceConsent} onClick={() => void action({ action: "appearance", consent: true }, "Appearance generated. Inspect it before approving its look.")}>Generate appearance (one paid request)</button></>}
        {["failed", "uncertain"].includes(job.appearanceState) && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={appearanceConsent} onChange={event => setAppearanceConsent(event.target.checked)} />I authorize a new paid appearance request. The prior receipt may already have incurred cost.</label><button className={petControl} disabled={busy || !appearanceConsent} onClick={() => void action({ action: "retryAppearance", consent: true }, "A separately consented appearance retry finished.")}>Retry appearance (new paid request)</button></>}
        {job.appearanceState === "succeeded" && <button className={petControl} disabled={busy} onClick={() => void action({ action: "approve" }, "Appearance approved. You can now authorize sprite generation.")}>Approve this appearance</button>}
        {job.appearanceState === "approved" && !job.buildConsentAt && <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={buildConsent} onChange={event => setBuildConsent(event.target.checked)} />I authorize ten separate sprite requests: nine animation-state grids and one 16-direction grid. Each is billed at variable published token rates; I understand there is no fixed quote or hard cap.</label><button className={petControl} disabled={busy || !buildConsent} onClick={() => void action({ action: "build", consent: true }, "Ten durable sprite request receipts were created. Start them explicitly when ready.")}>Authorize ten sprite requests</button></>}
        {job.buildConsentAt && <><div className="space-y-1 text-sm" aria-live="polite">{job.slots.filter(slot => slot.slotKey !== "appearance").map(slot => <div key={`${slot.slotKey}:${slot.attempt}`} className="flex flex-wrap items-center justify-between gap-2"><span>{slot.slotKey} · attempt {slot.attempt} · {slot.status}{slot.inputTokens !== null || slot.outputTokens !== null ? ` · ${slot.inputTokens ?? "?"} input / ${slot.outputTokens ?? "?"} output tokens` : ""}{slot.costMicros === null ? " · exact cost unavailable" : ` · ${slot.costMicros} micro-USD reported`}</span>{!job.catalogPetId && slot.isLatest && slot.attempt < 3 && ["failed", "uncertain", "succeeded"].includes(slot.status) && <button className={`${petControl} text-xs`} disabled={busy} onClick={() => void retry(slot.slotKey, slot.status === "succeeded")}>{slot.status === "succeeded" ? "Replace this state…" : "Authorize a paid retry…"}</button>}<details className="basis-full text-xs text-muted"><summary>Consent receipt v{slot.consentVersion}</summary><p>{slot.consentSummary}</p></details></div>)}</div><p className="text-xs text-muted">A slot left running after a crash is not replayed. Check its receipt; authorize a separate request only if you accept the chance the first request was billed.</p><button className={petControl} disabled={busy || !job.slots.some(slot => slot.status === "queued" && slot.slotKey !== "appearance")} onClick={() => void runQueued()}>{busy ? "Requests running…" : "Start queued requests"}</button>{job.previewErrorCode && <p role="status" className="text-sm text-danger">The sprite images are saved, but preview assembly failed. Retry the preview assembly below; it makes no image request and has no generation charge.</p>}{!job.hasPreview && job.slots.filter(slot => slot.isLatest && slot.slotKey !== "appearance").length === 10 && job.slots.filter(slot => slot.isLatest && slot.slotKey !== "appearance").every(slot => slot.status === "succeeded") && <button className={petControl} disabled={busy} onClick={() => void action({ action: "preview" }, "The validated preview was rebuilt from completed receipts.")}>{job.previewErrorCode ? "Retry nonbillable preview assembly" : "Assemble validated preview from saved receipts"}</button>}</>}
        {job.hasPreview && <><PetPreview src={`${detail(job.id)}/image?kind=preview`} manifest={{ displayName: job.displayName, description: job.description, credit: job.credit, spriteVersionNumber: 2 } satisfies PetManifest} /><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={visualReview} onChange={event => setVisualReview(event.target.checked)} />I reviewed all nine animation states and sixteen directions, including the actual avatar sizes in light and dark previews. Structural validation cannot judge artwork quality.</label>{memberMode ? <><label className="grid gap-1 text-sm">Assign private pet to a bot you can use<select className={petControl} value={assignBotId} onChange={event => setAssignBotId(event.target.value)}><option value="">Choose a private caller bot</option>{initial.assignableBots?.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label><button className={petControl} disabled={busy || !visualReview || !assignBotId} onClick={() => void action({ action: "assignPrivate", visualReview: true, botId: assignBotId }, "Reviewed v2 pet assigned privately to the selected bot.")}>Save and assign private pet</button></> : <><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={shareRights} onChange={event => setShareRights(event.target.checked)} />I confirm I have permission to add this generated artwork to the shared catalog; it will be saved as an unpublished draft.</label><button className={petControl} disabled={busy || !visualReview || !shareRights || !!job.catalogPetId} onClick={() => void action({ action: "save", rights: "confirmed", visualReview: true }, "Reviewed artwork saved as an unpublished catalog draft.")}>{job.catalogPetId ? "Saved as catalog draft" : "Save reviewed catalog draft"}</button></>}</>}
      </div>}
    </>}
    {notice && <p role="status" className="text-sm text-muted">{notice}</p>}{error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </section>;
}
