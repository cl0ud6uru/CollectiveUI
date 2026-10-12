"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { resetOwnWorkspaceInstance, stopOwnWorkspaceInstance } from "@/app/(chat)/settings/workspace-actions";
import type { WorkspaceInstanceView, WorkspaceTemplateList, WorkspaceTemplateSummary } from "@/lib/workspaces/contracts";

type BotOption = { id: string; name: string };

const stateLabel: Record<WorkspaceInstanceView["state"], string> = {
  missing: "Not started",
  provisioning: "Starting",
  ready: "Ready",
  unavailable: "Unavailable",
};

export function WorkspaceTemplatePicker({ bots }: { bots: BotOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [templates, setTemplates] = useState<WorkspaceTemplateSummary[]>([]);
  const [instances, setInstances] = useState<WorkspaceInstanceView[]>([]);
  const [botId, setBotId] = useState(bots[0]?.id ?? "");
  const [versionId, setVersionId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [catalogResponse, instancesResponse] = await Promise.all([
      fetch("/api/workspace/templates", { cache: "no-store" }),
      fetch("/api/workspace/instances", { cache: "no-store" }),
    ]);
    if (!catalogResponse.ok || !instancesResponse.ok) throw new Error("Workspace templates could not be loaded.");
    const catalog = await catalogResponse.json() as WorkspaceTemplateList;
    const own = await instancesResponse.json() as { instances: WorkspaceInstanceView[] };
    return {
      published: (catalog.templates ?? []).filter((t) => t.publishedVersionId),
      instances: own.instances ?? [],
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { published, instances: own } = await load();
      setTemplates(published);
      setInstances(own);
      setVersionId((current) => published.some((t) => t.publishedVersionId === current) ? current : published[0]?.publishedVersionId ?? "");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workspace templates could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    let active = true;
    void load().then(({ published, instances: own }) => {
      if (!active) return;
      setTemplates(published);
      setInstances(own);
      setVersionId((current) => published.some((t) => t.publishedVersionId === current) ? current : published[0]?.publishedVersionId ?? "");
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : "Workspace templates could not be loaded.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  const selected = templates.find((t) => t.publishedVersionId === versionId);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 className="font-medium">Private template workspaces</h3>
        <p className="mt-1 text-sm text-muted">
          Assign a version to a bot for your account. Each bot uses its own persistent files, even when other people share that bot.
        </p>
      </div>

      {bots.length === 0 ? <p className="text-sm text-muted">No accessible bots currently have the Workspace tool.</p> : (
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <label className="space-y-1 text-sm">
            <span className="block text-muted">Bot</span>
            <select aria-label="Bot for private workspace" value={botId} onChange={(e) => setBotId(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2">
              {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block text-muted">Template version</span>
            <select aria-label="Workspace template version" value={versionId} onChange={(e) => setVersionId(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2" disabled={loading || templates.length === 0}>
              {templates.map((template) => <option key={template.id} value={template.publishedVersionId ?? ""}>{template.name}</option>)}
            </select>
          </label>
          <Button
            disabled={pending || loading || !botId || !versionId}
            onClick={() => start(async () => {
              try {
                const response = await fetch("/api/workspace/bindings", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ botId, templateVersionId: versionId }),
                });
                const body = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(body.error ?? "The template could not be assigned.");
                toast.success("Private workspace assigned");
                await refresh();
                router.refresh();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "The template could not be assigned.");
              }
            })}
          >
            Assign
          </Button>
        </div>
      )}

      {selected && <p className="text-xs text-muted">Capabilities: {Object.entries(selected.capabilities).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none"}.</p>}
      <p className="text-xs text-muted">Changing versions keeps the previous instance and its files. Nothing is copied into the new version. Your legacy workspace remains available to bots without an explicit binding.</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {loading && <p className="text-xs text-muted">Loading templates…</p>}
      {!loading && !error && templates.length === 0 && <p className="text-sm text-muted">No published workspace templates are available yet.</p>}

      {instances.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted">Your registered workspaces</p>
          <ul className="space-y-1 text-xs text-muted">
            {instances.map((instance) => (
              <li key={instance.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
                <span>{instance.templateName ?? "Legacy personal workspace"}</span>
                <span className="ml-auto">{stateLabel[instance.state]}</span>
                {instance.origin === "template" && (
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
                      const result = await stopOwnWorkspaceInstance(instance.id);
                      if (result.ok) toast.success("Workspace stopped; files are kept"); else toast.error(result.error);
                    })}>Stop</Button>
                    <Button size="sm" variant="ghost" className="text-danger" disabled={pending || instance.state === "missing"} onClick={() => {
                      if (!window.confirm(`Delete all files in your ${instance.templateName ?? "private"} workspace?`)) return;
                      start(async () => {
                        const result = await resetOwnWorkspaceInstance(instance.id, "reset");
                        if (result.ok) toast.success("Workspace files deleted"); else toast.error(result.error);
                        await refresh();
                        router.refresh();
                      });
                    }}>Reset files</Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
