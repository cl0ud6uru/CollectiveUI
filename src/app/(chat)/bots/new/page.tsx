import { BotBuilder } from "@/components/bots/bot-builder";
import { PageFrame } from "@/components/page-frame";
import { loadBuilderData } from "@/lib/bots/builder-data";
import { newId } from "@/lib/ids";
import { randomBlob } from "@/components/bots/bot-avatar";
import { requirePagePrincipal } from "@/lib/session";

export default async function NewBotPage() {
  const p = await requirePagePrincipal();
  const data = await loadBuilderData(p);
  const firstToolApp = data.apps.find((a) => !a.agentServer && a.supportsTools) ?? data.apps.find((a) => !a.agentServer);
  return (
    <PageFrame title="New bot" wide>
      <div className="-mx-4 -mt-2 h-[calc(100dvh-3.5rem)] md:-mx-6">
        <BotBuilder
          initial={{
            name: "",
            avatar: randomBlob(),
            label: "",
            description: "",
            instructions: "",
            boundaries: "",
            appId: firstToolApp?.id ?? "",
            visibility: "private",
            groupIds: [],
            userIds: [],
            maxSteps: 10,
            starters: [],
            tools: [{ key: "memory", approval: "auto" }],
            delegateIds: [],
            delegatorIds: data.delegators.map(b => b.id),
            isCoordinator: false,
          }}
          newChatId={newId()}
          {...data}
        />
      </div>
    </PageFrame>
  );
}
