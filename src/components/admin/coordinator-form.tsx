"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveCoordinator, createQueenStarter } from "@/app/admin/coordinator-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { CoordinatorSettings } from "@/lib/settings";
import { Card } from "./ui";

type Choice = { id: string; name: string };
const selectStyle = "h-10 w-full min-w-0 rounded-lg border border-border bg-surface px-3 text-sm focus:outline-2 focus:outline-offset-2";

export function CoordinatorForm({ initial, bots, models }: { initial: CoordinatorSettings; bots: Choice[]; models: Choice[] }) {
  const router = useRouter();
  const [mode, setMode] = useState(initial.enabled ? "existing" : "off");
  const [botId, setBotId] = useState(initial.defaultBotId ?? "");
  const [name, setName] = useState("The Queen");
  const [appId, setAppId] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  function submit() {
    setError(""); setSaved("");
    start(async () => {
      try {
        if (mode === "starter") {
          const result = await createQueenStarter({ name, appId: appId || null });
          setBotId(result.id); setMode("existing");
          setSaved("Starter created. You can edit its name, personality, avatar and model in its bot settings.");
        } else {
          await saveCoordinator({ enabled: mode === "existing", defaultBotId: mode === "existing" ? botId : null });
          setSaved(mode === "off" ? "Default coordinator is off. Saved chats are unchanged." : "Default coordinator saved.");
        }
        router.refresh();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not save coordinator settings."); }
    });
  }
  return (
    <Card className="space-y-4">
      <h2 className="font-medium">Default coordinator</h2>
      <p className="text-sm text-muted">Give people a starting point for planning work and combining specialist answers. People following the organization default open their own coordinator home; personal start choices in Settings take precedence.</p>
      <form onSubmit={e => { e.preventDefault(); submit(); }} className="space-y-4">
        <div>
          <Label htmlFor="coordinator-mode">Setup</Label>
          <select id="coordinator-mode" value={mode} onChange={e => setMode(e.target.value)} className={selectStyle} disabled={pending}>
            <option value="off">Off</option>
            <option value="existing">Choose an existing bot</option>
            {!initial.starterBotId && <option value="starter">Create The Queen starter</option>}
          </select>
        </div>
        {mode === "existing" && <div>
          <Label htmlFor="coordinator-bot">Coordinator bot</Label>
          <select id="coordinator-bot" value={botId} onChange={e => setBotId(e.target.value)} required disabled={pending} className={selectStyle}>
            <option value="">Choose a native bot</option>
            {botId && !bots.some(b => b.id === botId) && <option value={botId} disabled>Selected bot is unavailable</option>}
            {bots.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <p className="mt-1 text-xs text-muted">Only its existing audience will see it. Selecting a bot keeps its identity, tools and model settings.</p>
          {botId && bots.some(b => b.id === botId) && <Link className="mt-2 inline-block text-sm underline" href={`/bots/${botId}/edit`}>Edit coordinator identity and model</Link>}
        </div>}
        {mode === "starter" && <div className="space-y-4">
          <div><Label htmlFor="coordinator-name">Starter name</Label><Input id="coordinator-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={pending} /></div>
          <div><Label htmlFor="coordinator-model">Model connection</Label><select id="coordinator-model" className={selectStyle} value={appId} onChange={e => setAppId(e.target.value)} disabled={pending}>
            <option value="">Configure later — no model selected</option>
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select></div>
          <p className="text-xs text-muted">Creates one organization-visible native bot with a shipped CollectiveUI avatar. No tools or model are added automatically. You can rename it, for example Lloyd GPT, and edit its personality later.</p>
        </div>}
        <p className="text-xs text-muted">Specialists must opt into “Allow coordinator delegation” in their bot settings. Assignments appear in linked task chats. Native async assignments return their results here before the coordinating reply continues.</p>
        <Button type="submit" disabled={pending || (mode === "existing" && (!botId || !bots.some(b => b.id === botId)))}>{pending ? "Saving…" : mode === "starter" ? "Create starter and select" : "Save coordinator"}</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {saved && <p role="status" className="text-sm text-muted">{saved}</p>}
      </form>
    </Card>
  );
}
