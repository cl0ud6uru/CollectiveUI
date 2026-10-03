import { McpAdmin, type McpServerView } from "@/components/admin/mcp-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { botMcpGrants, bots, groups, mcpServerAccess, mcpServers } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";
import { cleanDescription } from "@/lib/mcp/hygiene";
import type { McpToolDef } from "@/lib/mcp/kinds";

const toolView = (t: McpToolDef) => ({
  name: t.name,
  description: cleanDescription(t.description ?? t.title) ?? "",
  readOnly: t.annotations?.readOnlyHint === true,
  destructive: t.annotations?.destructiveHint === true,
});

export default async function AdminMcpPage() {
  const [servers, access, groupRows, grants] = await Promise.all([
    db.select().from(mcpServers).orderBy(mcpServers.name),
    db.select().from(mcpServerAccess),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    db.select({ grant: botMcpGrants, name: bots.name }).from(botMcpGrants).innerJoin(bots, eq(bots.id, botMcpGrants.botId)).where(isNull(botMcpGrants.revokedAt)),
  ]);
  // Never sent to the browser: headers, the identity secret (only whether they exist).
  const view: McpServerView[] = servers.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    url: s.url,
    transport: s.transport,
    hasHeaders: !!s.headersEnc,
    isPublic: s.isPublic,
    groupIds: access.filter((a) => a.serverId === s.id).map((a) => a.groupId),
    authorizedBots: grants.filter((g) => g.grant.serverId === s.id).map(({ grant: g, name }) => ({
      grantId: g.id, botId: g.botId, name, revision: g.botRevision, tool: g.toolName,
      effect: g.effect, approval: g.requireApproval, needsReview: g.serverRevision !== s.policyRevision,
    })),
    status: s.status,
    trust: s.trust,
    identityHeader: s.identityHeader,
    hasIdentitySecret: !!s.identitySecretEnc,
    resultBudgetKb: s.resultBudgetKb,
    timeoutSec: Math.round(s.timeoutMs / 1000),
    tools: (s.toolsSnapshot ?? []).map(toolView),
    toolPolicy: s.toolPolicy,
    drift: s.toolsDrift
      ? {
          hash: s.toolsDrift.hash,
          detectedAt: s.toolsDrift.detectedAt,
          added: s.toolsDrift.tools.filter((t) => s.toolsDrift!.added.includes(t.name)).map(toolView),
          changed: s.toolsDrift.tools.filter((t) => s.toolsDrift!.changed.includes(t.name)).map(toolView),
          removed: s.toolsDrift.removed,
        }
      : null,
    serverInfo: s.serverInfo,
    lastTestedAt: s.lastTestedAt?.toISOString() ?? null,
    lastError: s.lastError,
  }));
  return (
    <div>
      <AdminHeader
        title="MCP servers"
        description="Model Context Protocol servers expose your internal systems as tools bots can use. Credentials stay on the server. Add or import a server, test it to review its tools, then enable it."
      />
      <McpAdmin groups={groupRows} servers={view} />
    </div>
  );
}
