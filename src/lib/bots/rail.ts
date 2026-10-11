import type { ConversationSummary, TargetOption } from "@/components/chat/types";
import { visibleNavigationBots } from "./navigation";

/** Only the authorized roster is considered; the rail never restores access from a saved ID. */
export function railNavigationBots(bots: TargetOption[], activeBotId: string | undefined, capacity: number) {
  const all = bots.filter(bot => !bot.hidden || bot.id === activeBotId);
  const usual = new Set(visibleNavigationBots(bots, activeBotId));
  const candidates = all.filter(bot => usual.has(bot) || !!bot.status);
  const limit = Math.max(1, Math.floor(capacity));
  const visible = candidates.slice(0, limit);
  // Bring executing overflow bots into view without changing saved navigation order.
  for (const bot of candidates.filter(bot => !!bot.status)) {
    if (visible.includes(bot)) continue;
    const replace = visible.findLastIndex(row => !row.status && row.id !== activeBotId);
    if (replace >= 0) visible[replace] = bot;
  }
  const active = candidates.find(bot => bot.id === activeBotId);
  if (active && !visible.includes(active)) {
    visible[visible.length - 1] = active;
    // Retain saved relative order even when keeping the active bot past the limit.
  }
  visible.sort((a, b) => bots.indexOf(a) - bots.indexOf(b));
  return { all, visible, remaining: all.length - visible.length };
}

/** Activity comes from confirmed roster/task state, never timestamps, previews or the currently selected bot. */
export function botRailActivity(bot: TargetOption, conversations: ConversationSummary[]) {
  const tasks = conversations.filter(c => c.botId === bot.id && !c.archived && c.taskActivity).map(c => c.taskActivity!);
  const approval = bot.status === "waiting" || tasks.some(task => task.status === "waiting");
  const attention = approval || tasks.some(task => task.status === "failed" || task.status === "interrupted");
  const working = bot.status === "working" || tasks.some(task => task.status === "running" || task.status === "waiting_tasks");
  const unread = tasks.some(task => task.unread && ["succeeded", "failed", "interrupted", "cancelled"].includes(task.status));
  const label = approval ? "Needs your approval" : attention ? "Needs attention" : working ? "Working" : unread ? "Unread result" : "Idle";
  return { approval, attention, working, unread, label };
}
