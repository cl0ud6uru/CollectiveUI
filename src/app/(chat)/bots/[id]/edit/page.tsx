import { eq } from "drizzle-orm";
import { BotBuilder } from "@/components/bots/bot-builder";
import { PageFrame } from "@/components/page-frame";
import { db } from "@/db";
import { botAccess, botDelegates, botTools } from "@/db/schema";
import { getEditableBot } from "@/lib/authz";
import { loadBuilderData } from "@/lib/bots/builder-data";
import { botOption } from "@/lib/chat/targets";
import { newId } from "@/lib/ids";
import { requirePagePrincipal } from "@/lib/session";

export default async function EditBotPage(props: PageProps<"/bots/[id]/edit">) {
  const p = await requirePagePrincipal();
  const { id } = await props.params;
  const bot = await getEditableBot(p, id);
  const [data, tools, delegates, access] = await Promise.all([
    loadBuilderData(p, bot.id),
    db.select().from(botTools).where(eq(botTools.botId, bot.id)),
    db.select().from(botDelegates).where(eq(botDelegates.botId, bot.id)),
    db.select().from(botAccess).where(eq(botAccess.botId, bot.id)),
  ]);
  return (
    <PageFrame title={`Edit ${bot.name}`} wide>
      <div className="-mx-4 -mt-2 h-[calc(100dvh-3.5rem)] md:-mx-6">
        <BotBuilder
          key={bot.revision}
          botId={bot.id}
          initial={{
            name: bot.name,
            executionMode: bot.executionMode,
            coordinatorEligible: bot.coordinatorEligible,
            isCoordinator: bot.isCoordinator,
            avatar: bot.avatar,
            label: bot.label,
            description: bot.description,
            instructions: bot.instructions,
            boundaries: bot.boundaries,
            appId: bot.appId ?? "",
            visibility: bot.visibility,
            groupIds: access.map((a) => a.groupId),
            maxSteps: bot.maxSteps,
            starters: bot.starters,
            tools: tools.map((t) => ({ key: t.toolKey, approval: t.approval, config: t.config })),
            delegateIds: delegates.map((d) => d.delegateBotId),
          }}
          previewTarget={botOption(bot, data.apps.some((a) => a.id === bot.appId && a.agentServer))}
          newChatId={newId()}
          {...data}
        />
      </div>
    </PageFrame>
  );
}
