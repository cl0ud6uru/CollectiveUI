"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { publishServiceBot } from "@/app/(chat)/bots/actions";
import type { BotInput } from "@/app/(chat)/bots/actions";
import type { ToolOption } from "@/lib/bots/builder-data";
import type { ServiceGrantInput } from "@/lib/bots/service-policy";
import { Button } from "@/components/ui/button";
import { Select, Textarea } from "@/components/ui/input";

type Draft = { effect: "read" | "write"; requireApproval: boolean; scope: string };
const keyOf = (server: string, tool: string) => `${server}:${tool}`;

export function ServiceGrantEditor({ botId, revision, publishedRevision, publicationStatus, dirty, choices, options, initial }: {
  botId?: string; revision?: number; publishedRevision?: number | null; publicationStatus?: { published: boolean; reason: string }; dirty: boolean;
  choices: BotInput["tools"]; options: ToolOption[]; initial: ServiceGrantInput[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => {
    const out: Record<string, Draft> = {};
    for (const g of initial) {
      const key = keyOf(g.serverId, g.toolName);
      out[key] ??= { effect: g.effect, requireApproval: g.requireApproval, scope: JSON.stringify(g.constraints, null, 2) };
    }
    return out;
  });
  const selected = choices.flatMap((choice) => {
    const option = options.find((o) => o.key === choice.key);
    return (option?.mcpTools ?? []).filter((t) => !choice.config?.tools || choice.config.tools.includes(t.name)).map((t) => ({
      option: option!, tool: t, serverId: choice.key.slice(4), key: keyOf(choice.key.slice(4), t.name),
    }));
  });
  const missing = choices.flatMap(choice => (choice.config?.tools ?? []).filter(name =>
    !options.find(o => o.key === choice.key)?.mcpTools?.some(t => t.name === name)));
  const draft = (key: string): Draft => drafts[key] ?? { effect: "write", requireApproval: true, scope: "[]" };
  const change = (key: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [key]: { ...draft(key), ...patch } }));
  const publish = () => start(async () => {
    try {
      const grants = selected.map(({ option, tool, serverId, key }) => ({
        serverId, serverRevision: option.serverRevision!, toolName: tool.name, toolHash: tool.hash,
        effect: draft(key).effect, requireApproval: draft(key).requireApproval, constraints: JSON.parse(draft(key).scope),
      }));
      await publishServiceBot(botId!, revision!, grants);
      toast.success("Service bot published with these exact capabilities");
      router.refresh();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Publication failed"); }
  });
  return <section className="space-y-3 rounded-xl border border-border p-3">
    <div className="text-sm font-medium">Admin-authorized capabilities</div>
    <p className="text-xs text-muted">{publicationStatus?.reason ?? (publishedRevision === revision && revision ? "Published." : "Not published.")}{publicationStatus?.published ? "." : ""} Users in the bot audience can invoke these tools without direct connector access. Copies receive no grants.</p>
    <p className="text-xs text-muted">Review each tool&apos;s actual behavior. Server read-only hints do not prove safety. Writes always ask for approval. Each tool needs at least one exact scope constraint; other fields still follow its schema.</p>
    <p className="text-xs text-muted">Example scope: <code>{'[{"path":"project","source":"constant","value":"IT"},{"path":"requester","source":"caller.upn"}]'}</code>. Nested property paths are supported; arrays and query-language filtering are not. Use a narrow upstream tool that enforces these fields.</p>
    {!!missing.length && <p className="text-xs text-danger">Unavailable selected tools: {missing.join(", ")}. Review and save the selection before publishing.</p>}
    {selected.map(({ key, option, tool }) => <div key={key} className="space-y-2 rounded-lg bg-surface-2 p-3">
      <div className="text-sm font-medium">{option.label} · {tool.name}</div>
      <p className="text-xs text-muted">{tool.description}</p>
      <details className="text-xs"><summary>Reviewed tool definition</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap">{JSON.stringify(tool.definition, null, 2)}</pre></details>
      {!option.serviceReady && <p className="text-xs text-danger">The admin must enable trust and signed caller identity for this connector before publication.</p>}
      <Select aria-label={`${tool.name} effect`} value={draft(key).effect} onChange={(e) => {
        const effect = e.target.value as "read" | "write";
        change(key, { effect, requireApproval: true });
      }}>
        <option value="write">Write or unknown — always ask</option>
        <option value="read">Reviewed read operation</option>
      </Select>
      {draft(key).effect === "read" && <label className="flex gap-2 text-xs">
        <input type="checkbox" checked={draft(key).requireApproval} onChange={(e) => change(key, { requireApproval: e.target.checked })} /> Require approval every time
      </label>}
      <label className="block text-xs">Exact argument constraints
        <Textarea aria-label={`${tool.name} constraints`} rows={4} className="mt-1 font-mono text-xs"
          value={draft(key).scope} onChange={(e) => change(key, { scope: e.target.value })} />
      </label>
    </div>)}
    {(!botId || dirty) && <p className="text-xs text-muted">Save the bot draft before publishing. Saving profile or tool changes invalidates its previous publication.</p>}
    <Button onClick={publish} disabled={pending || !botId || !revision || dirty || !!missing.length || !selected.length || selected.some((s) => !s.option.serviceReady)}>
      {pending ? "Publishing…" : "Publish service bot"}
    </Button>
  </section>;
}
