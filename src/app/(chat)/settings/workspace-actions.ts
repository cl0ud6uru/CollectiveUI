"use server";

import { revalidatePath } from "next/cache";
import { execIdForToolCall } from "@/lib/agent/tools/workspace";
import { HttpError } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { SandboxError, sandboxd } from "@/lib/sandbox/client";
import { findSandbox, findWorkspaceInstance } from "@/lib/sandbox/store";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { workspaceView } from "@/lib/sandbox/view";
import { requirePrincipal } from "@/lib/session";

// Results carry friendly errors instead of throwing: production builds hide thrown server action messages.
type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

async function friendly<T>(fn: () => Promise<T>): Promise<Result<{ value: T }>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) return { ok: false, error: "Your portal session has expired. Sign in again." };
    if (err instanceof HttpError || err instanceof SandboxError) return { ok: false, error: err.message };
    console.error("[workspace] action failed", err);
    return { ok: false, error: "Something went wrong. Try again." };
  }
}

/** This person's own sandbox (never anyone else's): the ref comes from their session, not the browser. */
async function own() {
  const p = await requirePrincipal();
  const client = sandboxd();
  if (!client) throw new HttpError(400, "Workspaces aren't set up on this server.");
  const row = await findSandbox(p.user.id);
  return { p, client, ref: row?.ref ?? null };
}

export async function getWorkspaceStatus() {
  return friendly(async () => workspaceView(await requirePrincipal()));
}

/** Stops the container (files are kept; the next command starts it again). */
export async function stopWorkspace() {
  return friendly(async () => {
    const { p, client, ref } = await own();
    if (ref) await client.stop(ref);
    await audit(p.user.id, "workspace.stop", p.user.id);
    revalidatePath("/settings");
  });
}

/** Deletes the workspace's files and container. `confirm` must be "reset" (typed by the person). */
export async function resetWorkspace(confirm: string) {
  return friendly(async () => {
    if (confirm !== "reset") throw new HttpError(400, 'Type "reset" to confirm.');
    const { p, client, ref } = await own();
    if (ref) await client.destroy(ref);
    await audit(p.user.id, "workspace.reset", p.user.id);
    revalidatePath("/settings");
  });
}

/** The Stop button on a running command: kills it in this person's own workspace (no-op if it already ended). */
export async function stopWorkspaceCommand(toolCallId: string) {
  return friendly(async () => {
    if (typeof toolCallId !== "string" || toolCallId.length > 200) throw new HttpError(400, "Invalid tool call");
    const { client, ref } = await own();
    if (!ref) return false;
    return (await client.kill(ref, execIdForToolCall(toolCallId))).killed;
  });
}

/** Stops exactly one of this person's registered template instances and keeps its files. */
export async function stopOwnWorkspaceInstance(instanceId: string) {
  return friendly(async () => {
    if (typeof instanceId !== "string" || instanceId.length > 128) throw new HttpError(400, "Invalid workspace");
    const p = await requirePrincipal();
    const row = await findWorkspaceInstance(p.user.id, instanceId);
    if (!row || row.origin !== "template") throw new HttpError(404, "Workspace not found");
    const client = sandboxd();
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    await client.stop(row.sandboxRef);
    await audit(p.user.id, "workspace.instance_stop", row.id);
    revalidatePath("/settings");
  });
}

/** Resets only the selected private instance. The binding and profile pin remain; other instances are untouched. */
export async function resetOwnWorkspaceInstance(instanceId: string, confirm: string) {
  return friendly(async () => {
    if (confirm !== "reset") throw new HttpError(400, 'Type "reset" to confirm.');
    if (typeof instanceId !== "string" || instanceId.length > 128) throw new HttpError(400, "Invalid workspace");
    const p = await requirePrincipal();
    const row = await findWorkspaceInstance(p.user.id, instanceId);
    if (!row || row.origin !== "template") throw new HttpError(404, "Workspace not found");
    const client = sandboxd();
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    await client.destroy(row.sandboxRef);
    await db.update(schema.workspaceInstances).set({ provisionState: "missing", lastUsedAt: null }).where(and(
      eq(schema.workspaceInstances.ownerUserId, p.user.id),
      eq(schema.workspaceInstances.id, row.id),
    ));
    await audit(p.user.id, "workspace.instance_reset", row.id);
    revalidatePath("/settings");
  });
}
