"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { resetWorkspace, stopWorkspace } from "@/app/(chat)/settings/workspace-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkspaceView } from "@/lib/sandbox/view";

const STATE: Record<WorkspaceView["state"], { label: string; tone: string }> = {
  running: { label: "Running", tone: "bg-green-500/15 text-green-700 dark:text-green-300" },
  stopped: { label: "Stopped", tone: "bg-surface-2 text-muted" },
  missing: { label: "Not created yet", tone: "bg-surface-2 text-muted" },
  unavailable: { label: "Unavailable", tone: "bg-red-500/15 text-red-700 dark:text-red-300" },
};

function size(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Settings → Workspace: this person's own sandbox (status, stop, reset). */
export function WorkspacePanel({ view }: { view: WorkspaceView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState("");
  const [resetting, setResetting] = useState(false);
  const s = STATE[view.state];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium">Workspace</h2>
        <p className="mt-1 text-sm text-muted">
          Your private Linux workspace, where bots with workspace tools run commands and edit files for you. It has no network access, and only
          you (through your chats) can use it. Every command asks for your approval first. Files stay until you reset it.
        </p>
      </div>

      {!view.allowed && <p className="text-sm text-muted">Your organization hasn&apos;t enabled workspaces for you.</p>}
      {view.allowed && !view.configured && <p className="text-sm text-muted">Workspaces aren&apos;t set up on this server yet.</p>}

      {view.allowed && view.configured && (
        <div className="space-y-3 rounded-xl border border-border p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`rounded-full px-2 py-0.5 text-xs ${s.tone}`}>{s.label}</span>
            <span className="text-xs text-muted">
              {view.runtime === "runsc" ? "gVisor isolation" : view.runtime === "runc" ? "standard isolation" : ""}
              {view.usageBytes !== null ? ` · ${size(view.usageBytes)} used` : ""}
              {view.lastUsedAt ? ` · last used ${new Date(view.lastUsedAt).toLocaleString()}` : ""}
            </span>
          </div>
          {view.error && <p className="text-danger">{view.error}</p>}
          {view.scheduledDeletion && (
            <p className="text-amber-700 dark:text-amber-300">Scheduled for deletion on {new Date(view.scheduledDeletion).toLocaleDateString()}.</p>
          )}
          <p className="text-xs text-muted">Stopped workspaces start again automatically when a bot needs them. Idle ones stop after a while.</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending || view.state !== "running"}
              onClick={() =>
                start(async () => {
                  const r = await stopWorkspace();
                  if (r.ok) toast.success("Workspace stopped");
                  else toast.error(r.error);
                  router.refresh();
                })
              }
            >
              Stop
            </Button>
            {!resetting ? (
              <Button variant="outline" disabled={pending || view.state === "missing"} onClick={() => setResetting(true)}>
                Reset…
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">This deletes every file in your workspace. Type reset to confirm:</span>
                <Input aria-label="Type reset to confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="w-28" />
                <Button
                  variant="outline"
                  className="text-danger"
                  disabled={pending || confirm !== "reset"}
                  onClick={() =>
                    start(async () => {
                      const r = await resetWorkspace(confirm);
                      if (r.ok) toast.success("Workspace reset");
                      else toast.error(r.error);
                      setResetting(false);
                      setConfirm("");
                      router.refresh();
                    })
                  }
                >
                  Delete all files
                </Button>
                <Button variant="ghost" onClick={() => setResetting(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
