/** Navigation preferences never grant access: callers supply only the current accessible roster. */
export type NavigationBot = { id: string; name: string; pinned?: boolean; hidden?: boolean; coordinator?: boolean };
export type BotNavigationChange =
  | { kind: "preference"; botId: string; pinned?: boolean; hidden?: boolean }
  | { kind: "move"; botId: string; targetId: string; placement: "before" | "after" };

export function orderBots<T extends NavigationBot>(bots: T[], saved: readonly string[] = []): T[] {
  const byId = new Map(bots.map(b => [b.id, b]));
  const ordered: T[] = [];
  for (const id of saved) {
    const bot = byId.get(id);
    if (bot) { ordered.push(bot); byId.delete(id); }
  }
  return [...ordered, ...Array.from(byId.values()).sort((a, b) =>
    Number(!!b.pinned) - Number(!!a.pinned) || Number(!!b.coordinator) - Number(!!a.coordinator) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))];
}

/** A move preserves pin state. Newly pinned bots join the end of the existing pins, without sorting other rows. */
export function changeBotNavigation<T extends NavigationBot>(bots: T[], change: BotNavigationChange): T[] {
  const bot = bots.find(b => b.id === change.botId);
  if (!bot) return bots;
  if (change.kind === "move") {
    if (bot.hidden || change.botId === change.targetId || !bots.some(b => b.id === change.targetId && !b.hidden)) return bots;
    const rest = bots.filter(b => b.id !== bot.id);
    rest.splice(rest.findIndex(b => b.id === change.targetId) + Number(change.placement === "after"), 0, bot);
    return rest;
  }
  const next = { ...bot, ...(change.pinned === undefined ? {} : { pinned: change.pinned }), ...(change.hidden === undefined ? {} : { hidden: change.hidden }) };
  if (change.pinned) next.hidden = false;
  if (change.hidden) next.pinned = false;
  if (next.pinned && !bot.pinned) {
    const rest = bots.filter(b => b.id !== bot.id);
    const lastPin = rest.findLastIndex(b => b.pinned && !b.hidden);
    rest.splice(lastPin + 1, 0, next);
    return rest;
  }
  return bots.map(b => b.id === bot.id ? next : b);
}

export function visibleNavigationBots<T extends NavigationBot>(bots: T[], activeBotId?: string): T[] {
  // The parent sidebar scrolls. Never truncate while moving: doing so can unmount the focused row.
  return bots.filter(b => !b.hidden || b.id === activeBotId);
}
