"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, History, Home, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { archiveConversation, deleteConversation } from "@/app/(chat)/actions";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useShell } from "./shell-context";
import { StartSideChat } from "./start-side-chat";

/** Always reachable on narrow screens; history includes ordinary chats and routine results. */
export function BotChatNavigation({ botId, isHome, conversationId, onNewHome }: { botId: string; isHome: boolean; conversationId: string; onNewHome?: () => void }) {
  const { conversations, removeConversation } = useShell();
  const router = useRouter();
  const recent = conversations.filter((c) => c.botId === botId && c.id !== conversationId && !c.isBotHome && !c.archived).slice(0, 8);
  async function retire(remove: boolean) {
    if (remove && !confirm("Delete this home chat?")) return;
    try {
      await (remove ? deleteConversation(conversationId) : archiveConversation(conversationId));
      removeConversation(conversationId);
      router.push("/");
      toast.success(remove ? "Chat deleted" : "Chat archived");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not update this chat"); }
  }
  return <div className="flex items-center gap-1">
    {!isHome && <Link prefetch={false} href={`/?bot=${botId}`} aria-label="Open home chat" title="Open home chat" className="rounded-lg p-2 text-muted hover:bg-hover"><Home className="h-4 w-4" /></Link>}
    <StartSideChat botId={botId} compact />
    <Menu>
      <MenuTrigger asChild><button aria-label="Bot chat history" title="Bot chat history" className="rounded-lg p-2 text-muted hover:bg-hover"><History className="h-4 w-4" /></button></MenuTrigger>
      <MenuContent align="end" className="max-w-[calc(100vw-2rem)]">
        <MenuLabel>{isHome ? "Home chat" : "Side chat"}</MenuLabel>
        <MenuItem asChild><Link prefetch={false} href={`/?bot=${botId}`}><Home /> Open home chat</Link></MenuItem>
        {isHome && <MenuItem onSelect={onNewHome}>Start fresh home (/new)</MenuItem>}
        <MenuSeparator />
        {recent.length ? recent.map((c) => <MenuItem key={c.id} asChild><Link href={`/c/${c.id}`} className="max-w-72 truncate">{c.isBotHome ? "Home · " : c.source === "routine" ? "Routine · " : ""}{c.title}</Link></MenuItem>) : <MenuLabel>No other chats yet</MenuLabel>}
        <MenuItem asChild><Link href={`/bots/${botId}/chats`}><History /> All chats and archives</Link></MenuItem>
        {isHome && <><MenuSeparator />
          <MenuItem onSelect={() => void retire(false)}><Archive /> Archive</MenuItem>
          <MenuItem danger onSelect={() => void retire(true)}><Trash2 /> Delete</MenuItem>
        </>}
      </MenuContent>
    </Menu>
  </div>;
}
