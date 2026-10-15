"use client";

import { useEffect, useState } from "react";
import { listOpenRouterModels } from "@/app/admin/model-catalog-actions";
import type { CatalogModel } from "@/lib/llm/catalog";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";

export function ModelCatalogPicker({ value, onChange }: { value: string; onChange: (id: string, model?: CatalogModel) => void }) {
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const result = await listOpenRouterModels();
        if (!active) return;
        if (result.ok) setModels(result.models);
        else setError(result.error);
      } catch {
        if (active) setError("OpenRouter’s model catalog could not be loaded. Retry, or enter a model ID manually.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [attempt]);

  const query = search.trim().toLowerCase();
  const filtered = models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query));
  const selected = models.find(m => m.id === value);
  const options = selected && !filtered.includes(selected) ? [selected, ...filtered] : filtered;
  const showManual = manual || (!loading && (!!error || models.length === 0));
  return <div className="min-w-0 space-y-3 break-words sm:col-span-2">
    <p className="text-sm font-medium">OpenRouter models</p>
    <p role="status" className="text-xs text-muted">{loading ? "Loading OpenRouter models…" : error ?? (models.length ? `${models.length} models. Search by name or ID. The public catalog does not verify your key or model access.` : "No chat models were returned. Enter a model ID manually or retry.")}</p>
    {!showManual && <>
      <Field label="Search OpenRouter models"><Input aria-label="Search OpenRouter models" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search names or provider/model IDs" /></Field>
      <Field label="Model" hint={value ? `Selected model ID: ${value}` : "Choose a model to save this connection."}>
        <Select aria-label="OpenRouter model" value={value} disabled={loading} onChange={e => onChange(e.target.value, models.find(m => m.id === e.target.value))}>
          <option value="">Choose a model…</option>
          {value && !selected && <option value={value}>{value} (manual ID)</option>}
          {options.map(m => <option key={m.id} value={m.id}><span className="block max-w-[min(32rem,calc(100vw-6rem))] truncate">{m.name} · {m.id}</span></option>)}
        </Select>
      </Field>
      {!loading && query && !filtered.length && <p className="text-xs text-muted">No matching models. Try another search or enter an ID manually.</p>}
    </>}
    {showManual && <Field label="Model ID" hint="Use the exact OpenRouter model ID, including the provider prefix. Manual IDs can be saved even when the catalog is unavailable."><Input aria-label="Model" value={value} onChange={e => onChange(e.target.value)} placeholder="provider/model" /></Field>}
    <div className="flex flex-wrap gap-2">
      {(!showManual || models.length > 0) && <Button variant="outline" onClick={() => setManual(x => !x)}>{showManual ? "Browse model catalog" : "Enter model ID manually"}</Button>}
      <Button variant="ghost" disabled={loading} onClick={() => setAttempt(x => x + 1)}>Reload models</Button>
    </div>
  </div>;
}
