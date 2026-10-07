"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addOfficeBot } from "@/app/admin/bots/office-actions";

export function OfficeBotInstaller({ models, botId }: { models: { id: string; name: string }[]; botId: string | null }) {
  const [appId, setAppId] = useState(models[0]?.id ?? "");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  return (
    <section className="mb-6 rounded-2xl border border-border p-4" aria-labelledby="office-bot-title">
      <h2 id="office-bot-title" className="font-semibold">Office Bot</h2>
      <p className="mt-1 text-sm text-muted">Word, Excel, PowerPoint, and PDF files, with finished downloads in chat. Files stay in each person’s private workspace.</p>
      {botId ? <Link href={`/bots/${botId}`} className="mt-3 inline-block text-sm underline">Open Office Bot</Link> : (
        <form className="mt-3 flex flex-wrap items-end gap-3" action={() => startTransition(async () => {
          setError("");
          try {
            const result = await addOfficeBot(appId);
            if (result.ok) { router.push(`/bots/${result.botId}`); router.refresh(); }
            else setError(result.error);
          } catch { setError("Could not add Office Bot. Refresh the page and try again."); }
        })}>
          <label className="flex flex-col gap-1 text-sm">Model
            <select className="rounded-lg border border-border bg-surface px-3 py-2" value={appId} onChange={e => setAppId(e.target.value)} disabled={pending || !models.length} required>
              {!models.length && <option value="">No eligible models</option>}
              {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
            </select>
          </label>
          <button className="rounded-lg bg-accent px-4 py-2 text-sm text-white disabled:opacity-50" disabled={pending || !appId}>{pending ? "Checking workspace…" : "Add Office Bot"}</button>
        </form>
      )}
      {!botId && <p className="mt-2 text-xs text-muted">Requires a public company model with tools and the Office sandbox image. Existing workspace access and approvals apply.</p>}
      {!botId && !models.length && <p className="mt-2 text-sm">Add or enable a public company model with tool support in Admin → Models.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
    </section>
  );
}
