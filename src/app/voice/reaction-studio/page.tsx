import { VoiceReactionStudio } from "@/components/chat/voice-reaction-studio";
import { requirePagePrincipal } from "@/lib/session";
import { targetFor } from "@/lib/voice/target";
import { getSetting } from "@/lib/settings";
import { CLIENT_ID_RE } from "@/lib/ids";

export const metadata = { title: "Voice reaction studio" };
export default async function ReactionStudioPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const principal = await requirePagePrincipal();
  const query = await searchParams;
  const conversationId = typeof query.conversationId === "string" && CLIENT_ID_RE.test(query.conversationId) ? query.conversationId : undefined;
  // Resolve normal conversation ownership/audience; no connection details or history enter client props.
  if (conversationId) await targetFor(principal, { conversationId });
  const settings = await getSetting("voice");
  return <VoiceReactionStudio key={conversationId} initialModelUrl={settings.avatarUrl} conversationId={conversationId}
    setupMessage="Open this studio from the voice window of the chat you want to test, so it can use that chat’s existing authorized connection."/>;
}
