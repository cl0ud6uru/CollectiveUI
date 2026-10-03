import type { Principal } from "@/lib/auth/groups";
import { getSetting } from "@/lib/settings";
import { SandboxError, sandboxd } from "./client";
import { requiredIsolation, userMayUseWorkspace } from "./policy";
import { findSandbox } from "./store";

/** What Settings → Workspace shows. Nothing secret: no refs, no paths outside the person's own workspace. */
export type WorkspaceView = {
  allowed: boolean;
  configured: boolean;
  state: "running" | "stopped" | "missing" | "unavailable";
  runtime: "runc" | "runsc" | null;
  lastUsedAt: string | null;
  usageBytes: number | null;
  error: string | null;
  scheduledDeletion: string | null;
};

export async function workspaceView(p: Principal): Promise<WorkspaceView | null> {
  const settings = await getSetting("sandbox");
  if (!settings.enabled) return null;
  const allowed = userMayUseWorkspace(p, settings);
  const client = sandboxd();
  const row = await findSandbox(p.user.id);
  const base: WorkspaceView = {
    allowed,
    configured: !!client,
    state: "missing",
    runtime: null,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
    usageBytes: null,
    error: null,
    scheduledDeletion: row?.deleteAfter?.toISOString() ?? null,
  };
  if (!client || !row) return base;
  try {
    const s = await client.state(row.ref);
    const usage = s.state === "running" ? await client.usage(row.ref, requiredIsolation(settings)).catch(() => ({ bytes: null })) : { bytes: null };
    return { ...base, state: s.state, runtime: s.runtime, usageBytes: usage.bytes };
  } catch (err) {
    return { ...base, state: "unavailable", error: err instanceof SandboxError ? err.message : "The workspace service isn't reachable right now." };
  }
}
