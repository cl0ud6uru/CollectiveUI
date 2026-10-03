import { asc } from "drizzle-orm";
import { AppsAdmin, type AppRow } from "@/components/admin/apps-admin";
import { AdminHeader } from "@/components/admin/ui";
import { db } from "@/db";
import { aiApps, appAccess, groups } from "@/db/schema";
import { isAppProvider, isEnabledKind, readChatGPTConfig, readProviderConfig } from "@/lib/llm/catalog";
import { requireAdminPage } from "@/lib/session";
import { getSetting } from "@/lib/settings";

export default async function AdminAppsPage() {
  await requireAdminPage();
  const [apps, access, groupRows, chatgpt] = await Promise.all([
    db.select().from(aiApps).orderBy(asc(aiApps.sortOrder), asc(aiApps.name)),
    db.select().from(appAccess),
    db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(groups.name),
    getSetting("chatgpt"),
  ]);
  // Only non-secret fields reach the browser; the config is re-parsed so unknown keys never leak.
  const rows: AppRow[] = apps.flatMap((a) =>
    isAppProvider(a.provider) && a.providerConfig.managed === undefined && a.providerConfig.local === undefined && a.providerConfig.docker === undefined
      ? [
          {
            id: a.id,
            name: a.name,
            description: a.description,
            icon: a.icon,
            provider: a.provider,
            config: (isEnabledKind(a.provider) ? (readProviderConfig(a.provider, a.providerConfig) ?? {}) : readChatGPTConfig(a.providerConfig)) as Record<
              string,
              unknown
            >,
            baseUrl: a.baseUrl,
            hasKey: !!a.apiKeyEnc,
            model: a.model,
            systemPrompt: a.systemPrompt,
            temperature: a.temperature,
            maxTokens: a.maxTokens,
            supportsVision: a.supportsVision,
            supportsTools: a.supportsTools,
            embeddingModel: a.embeddingModel,
            isPublic: a.isPublic,
            enabled: a.enabled,
            sortOrder: a.sortOrder,
            groupIds: access.filter((x) => x.appId === a.id).map((x) => x.groupId),
          },
        ]
      : [],
  );
  return (
    <div>
      <AdminHeader
        title="Connections"
        description="Configure models for New Chat and native bots, and agent backends for bots. Provider connections select a model or deployment; Hermes runs its own models and tools. Keys stay encrypted on the server."
      />
      <AppsAdmin groups={groupRows} apps={rows} chatgptEnabled={chatgpt.enabled} />
    </div>
  );
}
