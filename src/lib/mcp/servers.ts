import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers, type McpServer } from "@/db/schema";
import { audit } from "@/lib/audit";
import { connectMcp, mcpErrorMessage } from "./client";
import type { McpDrift, McpServerInfo, McpToolDef, McpToolPolicy } from "./kinds";
import { diffTools, hiddenByDrift, listAllTools, snapshotHash } from "./snapshot";

export type RefreshOutcome =
  | { ok: true; result: "captured" | "unchanged" | "drift" | "resolved"; tools: McpToolDef[]; drift: McpDrift | null }
  | { ok: false; error: string };

/**
 * Lists a server's tools (as the portal itself, not as whoever clicked Test) and records the result:
 *  - no accepted list yet, or still a draft: the list becomes the accepted snapshot;
 *  - same as the accepted list: nothing changes (a pending change that went away is cleared);
 *  - different: kept as a pending change for an admin to review. An enabled server moves to needs_review and its
 *    changed or removed tools are hidden until the change is accepted; new tools aren't offered until then either.
 */
export async function refreshMcpServer(serverId: string, actorId: string | null = null): Promise<RefreshOutcome> {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
  if (!server) return { ok: false, error: "Not found" };

  let tools: McpToolDef[];
  let info: McpServerInfo;
  try {
    const client = await connectMcp(server, { subject: { kind: "system" } });
    try {
      tools = await listAllTools(client, { timeout: server.timeoutMs });
      const init = client.initializeResult;
      info = { name: init?.serverInfo?.name, version: init?.serverInfo?.version, protocolVersion: init?.protocolVersion };
    } finally {
      await client.close().catch(() => {});
    }
  } catch (err) {
    const error = mcpErrorMessage(err, server);
    await db.update(mcpServers).set({ lastTestedAt: new Date(), lastError: error }).where(eq(mcpServers.id, serverId));
    return { ok: false, error };
  }

  const hash = snapshotHash(tools);
  const outcome = await db.transaction(async (tx) => {
    // Under the row lock, so a Test click and the refresh job can't interleave their writes.
    const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, serverId)).for("update");
    if (!row) return null;
    // The URL changed while we were listing: this list belongs to the old server.
    if (row.url !== server.url || row.transport !== server.transport) return null;
    const base = { lastTestedAt: new Date(), lastError: null, serverInfo: info };
    if (!row.toolsSnapshot || row.status === "draft") {
      await tx
        .update(mcpServers)
        .set({ ...base, toolsSnapshot: tools, toolsHash: hash, toolsDrift: null, toolPolicy: prunePolicy(row.toolPolicy, tools) })
        .where(eq(mcpServers.id, serverId));
      return { result: "captured" as const, drift: null };
    }
    if (hash === row.toolsHash) {
      await tx
        .update(mcpServers)
        .set({ ...base, toolsDrift: null, ...(row.status === "needs_review" ? { status: "enabled" as const } : {}) })
        .where(eq(mcpServers.id, serverId));
      return { result: row.toolsDrift ? ("resolved" as const) : ("unchanged" as const), drift: null };
    }
    const drift: McpDrift = {
      detectedAt: row.toolsDrift?.hash === hash ? row.toolsDrift.detectedAt : new Date().toISOString(),
      hash,
      tools,
      ...diffTools(row.toolsSnapshot, tools),
    };
    await tx
      .update(mcpServers)
      .set({ ...base, toolsDrift: drift, ...(row.status === "enabled" ? { status: "needs_review" as const } : {}) })
      .where(eq(mcpServers.id, serverId));
    return { result: "drift" as const, drift, isNew: row.toolsDrift?.hash !== hash };
  });
  if (!outcome) return { ok: false, error: "The server changed while its tools were being listed. Test again." };
  if ("isNew" in outcome && outcome.isNew) {
    const d = outcome.drift!;
    await audit(actorId, "mcp.drift", serverId, { name: server.name, added: d.added, changed: d.changed, removed: d.removed });
  }
  return { ok: true, result: outcome.result, tools, drift: outcome.drift };
}

/** Accepts a pending tool-list change. `hash` is the change the admin reviewed; a newer one must be reviewed first. */
export async function acceptMcpDrift(serverId: string, hash: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(mcpServers).where(eq(mcpServers.id, serverId)).for("update");
    if (!row?.toolsDrift) return { ok: false as const, error: "There are no pending changes." };
    if (row.toolsDrift.hash !== hash) return { ok: false as const, error: "The tool list changed again. Review the latest changes." };
    const tools = row.toolsDrift.tools;
    await tx
      .update(mcpServers)
      .set({
        toolsSnapshot: tools,
        policyRevision: sql`${mcpServers.policyRevision} + 1`,
        toolsHash: hash,
        toolsDrift: null,
        toolPolicy: prunePolicy(row.toolPolicy, tools),
        ...(row.status === "needs_review" ? { status: "enabled" as const } : {}),
      })
      .where(eq(mcpServers.id, serverId));
    return { ok: true as const };
  });
}

function prunePolicy(policy: McpToolPolicy, tools: McpToolDef[]): McpToolPolicy {
  const names = new Set(tools.map((t) => t.name));
  return Object.fromEntries(Object.entries(policy).filter(([name]) => names.has(name)));
}

/** The tools bots may use from this server: the accepted list, minus tools off by admin or hidden by a pending change. */
export function offeredTools(server: Pick<McpServer, "toolsSnapshot" | "toolsDrift" | "toolPolicy">): McpToolDef[] {
  const hidden = hiddenByDrift(server.toolsDrift);
  return (server.toolsSnapshot ?? []).filter((t) => !hidden.has(t.name) && server.toolPolicy[t.name]?.enabled !== false);
}

/** Refreshes every server in use (enabled or waiting for review). Used by the worker's hourly job. */
export async function refreshAllMcpServers(): Promise<{ checked: number; drifted: number; failed: number }> {
  const rows = await db.select({ id: mcpServers.id }).from(mcpServers).where(inArray(mcpServers.status, ["enabled", "needs_review"]));
  let drifted = 0;
  let failed = 0;
  for (const { id } of rows) {
    const r = await refreshMcpServer(id);
    if (!r.ok) failed++;
    else if (r.result === "drift") drifted++;
  }
  return { checked: rows.length, drifted, failed };
}
