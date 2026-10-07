import { ToolSettingsForm } from "@/components/admin/tool-settings-form";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { aiApps } from "@/db/schema";
import { BUILTIN_TOOLS } from "@/lib/agent/types";
import { isEligibleEmbeddingApp, isEligibleUtilityApp } from "@/lib/llm/catalog";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { DecisionsForm } from "@/components/admin/decisions-form";
import { decisionsCapability } from "@/lib/decisions-policy";

export default async function AdminToolsPage() {
  await requireAdminPage();
  const [t, decisions, appRows] = await Promise.all([
    getSetting("tools"),
    getSetting("decisions"),
    db
      .select({
        id: aiApps.id,
        name: aiApps.name,
        enabled: aiApps.enabled,
        kind: aiApps.kind,
        provider: aiApps.provider,
        credentialMode: aiApps.credentialMode,
        embeddingModel: aiApps.embeddingModel,
        baseUrl: aiApps.baseUrl,
      })
      .from(aiApps),
  ]);
  // Background work only runs on company credentials; only these apps can be picked.
  const utilityApps = appRows.filter(isEligibleUtilityApp).map((a) => ({ id: a.id, name: a.name }));
  const embeddingApps = appRows.filter(isEligibleEmbeddingApp).map((a) => ({ id: a.id, name: `${a.name} (${a.embeddingModel})` }));
  return (
    <div>
      <AdminHeader title="Bots & tools" description="Org-wide guardrails for bots: who can build them, which tools exist, and which actions always need a human." />
      <ToolSettingsForm
        initial={{
          disabledTools: t.disabledTools,
          enforcedApproval: t.enforcedApproval,
          fetchAllowlist: t.fetchAllowlist,
          webSearch: { provider: t.webSearch.provider, url: t.webSearch.url, hasKey: !!t.webSearch.apiKeyEnc },
          nativeSearch: t.nativeSearch,
          maxStepsCap: t.maxStepsCap,
          botCreation: t.botCreation,
          utilityAppId: t.utilityAppId,
          embeddingAppId: t.embeddingAppId,
          learningEnabled: t.learningEnabled,
        }}
        tools={[...BUILTIN_TOOLS.map((b) => ({ key: b.key, label: b.label })), { key: "mcp", label: "All MCP servers" }]}
        utilityApps={utilityApps}
        embeddingApps={embeddingApps}
      />
      <DecisionsForm initial={decisions} providers={appRows.filter(decisionsCapability).map(a => ({ id: a.id, name: a.name }))} />
    </div>
  );
}
