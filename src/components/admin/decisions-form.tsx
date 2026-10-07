"use client";

import { useState, useTransition } from "react";
import { saveDecisionsSettings } from "@/app/admin/decisions-actions";
import { DECISIONS_NOTICE, type DecisionsSettings } from "@/lib/decisions-policy";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/input";
import { Card } from "./ui";

export function DecisionsForm({ initial, providers }: { initial: DecisionsSettings; providers: { id: string; name: string }[] }) {
  const [value, setValue] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const available = providers.some(p => p.id === value.providerAppId);
  return <Card className="mt-6">
    <details>
      <summary className="cursor-pointer text-sm font-medium">OpenAI Decisions (beta)</summary>
      <form className="mt-4 space-y-4" onSubmit={e => {
        e.preventDefault(); setError(""); setSaved(false);
        start(async () => {
          try { await saveDecisionsSettings(value); setSaved(true); }
          catch (err) { setError(err instanceof Error ? err.message : "Could not save Decisions settings."); }
        });
      }}>
        <p className="text-sm text-muted">{DECISIONS_NOTICE}</p>
        <Field label="Decisions API connection">
          <Select aria-label="Decisions API connection" value={value.providerAppId ?? ""} disabled={pending} onChange={e => {
            setSaved(false); setValue({ ...value, providerAppId: e.target.value || null });
          }}>
            <option value="">Choose an existing OpenAI API connection</option>
            {value.providerAppId && !available && <option value={value.providerAppId} disabled>Selected connection is unavailable</option>}
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        {!providers.length && <p className="text-sm text-muted">Add a company OpenAI API connection in Models first. Custom endpoints, ChatGPT plans and Hermes are unsupported.</p>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.queenRouting} disabled={pending || (!available && !value.queenRouting)} onChange={e => {
            setSaved(false); setValue({ ...value, queenRouting: e.target.checked });
          }} />
          Queen bot routing
        </label>
        <p className="text-xs text-muted">Helps Queen choose an allowed specialist for a clear request. Queen still plans the assignment and follows normal approval rules. Explicit specialist choices and related tasks keep their existing behavior.</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value.skillPicking} disabled={pending || (!available && !value.skillPicking)} onChange={e => {
            setSaved(false); setValue({ ...value, skillPicking: e.target.checked });
          }} />
          Skill picking
        </label>
        <p className="text-xs text-muted">Shows relevant optional skills in new native bot turns. Pinned procedures, mandatory policies and explicit skill commands stay available. The bot still loads skills through normal permissions and approvals.</p>
        <Button type="submit" disabled={pending || ((value.queenRouting || value.skillPicking) && !available)}>{pending ? "Saving…" : "Save Decisions settings"}</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {saved && <p role="status" className="text-sm text-muted">Decisions settings saved.</p>}
      </form>
    </details>
  </Card>;
}
