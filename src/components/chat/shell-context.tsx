"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Branding, ConversationSummary, CurrentUser, FolderSummary, TargetOption } from "./types";
import { mergeRecentTasks } from "@/lib/chat/recent-task-state";

type ShellState = {
  user: CurrentUser;
  branding: Branding;
  conversations: ConversationSummary[];
  currentConversation: ConversationSummary | null;
  setCurrentConversation: (c: ConversationSummary | null) => void;
  folders: FolderSummary[];
  apps: TargetOption[];
  bots: TargetOption[];
  inboxUnread: number;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  mobileOpen: boolean;
  setMobileOpen: (v: boolean) => void;
  searchOpen: boolean;
  setSearchOpen: (v: boolean) => void;
  upsertConversation: (c: Partial<ConversationSummary> & { id: string }) => void;
  removeConversation: (id: string) => void;
  /** The home chat's latest line as it changes, until the layout refreshes. A key set to undefined drops the override. */
  setBotLive: (botId: string, patch: BotLive) => void;
  /**
   * What one open chat is doing (null when idle). A bot's roster status is the most urgent of the server's (all its
   * chats when the layout last rendered) and every chat reported here, so an idle chat never hides another one's work.
   */
  setChatStatus: (conversationId: string, botId: string, status: RosterStatus | null) => void;
  /** The roster as the server last rendered it, without live overrides. */
  serverBots: TargetOption[];
};

export type BotLive = Partial<Pick<TargetOption, "preview" | "lastAt">>;
export type RosterStatus = NonNullable<TargetOption["status"]>;

const URGENCY: Record<RosterStatus, number> = { working: 1, waiting: 2 };
/** The most urgent status: waiting for you beats working, which beats idle. */
export function mostUrgent(statuses: (RosterStatus | null | undefined)[]): RosterStatus | null {
  return statuses.reduce<RosterStatus | null>((best, s) => (s && (!best || URGENCY[s] > URGENCY[best]) ? s : best), null);
}

const Ctx = createContext<ShellState | null>(null);

// Sidebar open/closed preference persisted in localStorage.
const SIDEBAR_KEY = "sidebar-open";
const sidebarListeners = new Set<() => void>();
function subscribeSidebar(cb: () => void) {
  sidebarListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    sidebarListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function readSidebar() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "false";
  } catch {
    return true;
  }
}
function writeSidebar(v: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(v));
  } catch {}
  sidebarListeners.forEach((l) => l());
}

/** Apply a live roster patch: undefined drops that override (the server's value shows again); same values are a no-op. */
export function mergeBotLive(prev: BotLive, patch: BotLive): BotLive {
  if (Object.entries(patch).every(([k, v]) => prev[k as keyof BotLive] === v)) return prev;
  const next: BotLive = { ...prev, ...patch };
  for (const k of Object.keys(next) as (keyof BotLive)[]) if (next[k] === undefined) delete next[k];
  return next;
}

export function useShell() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useShell outside ShellProvider");
  return v;
}

export function ShellProvider({
  children,
  ...initial
}: {
  children: React.ReactNode;
  user: CurrentUser;
  branding: Branding;
  conversations: ConversationSummary[];
  folders: FolderSummary[];
  apps: TargetOption[];
  bots: TargetOption[];
  inboxUnread: number;
}) {
  const [workStatuses, setWorkStatuses] = useState<Record<string, RosterStatus | null> | null>(null);
  useEffect(() => {
    let alive = true, pending = false;
    const refresh = async () => {
      if (document.hidden || pending) return;
      pending = true;
      try { const { refreshBotStatuses } = await import("@/app/(chat)/actions"); const statuses = await refreshBotStatuses(); if (alive) setWorkStatuses(statuses); }
      catch { /* Keep the last confirmed status until the next successful refresh. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("bot-work-changed", refresh);
    return () => { alive = false; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("bot-work-changed", refresh); };
  }, [initial.bots]);
  const [conversations, setConversations] = useState(initial.conversations);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false, again = false;
    const refresh = async () => {
      if (document.hidden || controller.signal.aborted) return;
      if (pending) { again = true; return; }
      pending = true;
      try {
        const response = await fetch("/api/chat/recent-tasks", { cache: "no-store", signal: controller.signal });
        if (response.ok) {
          const tasks = await response.json() as ConversationSummary[];
          if (!controller.signal.aborted) setConversations(current => mergeRecentTasks(current, tasks));
        } else if (response.status === 401 || response.status === 403) {
          setConversations(current => current.filter(c => c.source !== "delegation"));
        }
      } catch { /* Reconnect/focus and the next poll recover missed snapshots. Never infer a run status. */ }
      finally {
        pending = false;
        if (again) { again = false; void refresh(); }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("recent-tasks-changed", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort(); clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("recent-tasks-changed", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [initial.conversations, initial.user.id]);
  const [serverConversations, setServerConversations] = useState(initial.conversations);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [currentConversation, setCurrent] = useState<ConversationSummary | null>(null);
  const [botLive, setBotLiveState] = useState<{
    source: TargetOption[];
    byBot: Record<string, BotLive>;
    chats: Record<string, { botId: string; status: RosterStatus }>;
  }>({ source: initial.bots, byBot: {}, chats: {} });

  // Server data wins whenever the layout re-renders (router.refresh / revalidatePath).
  if (serverConversations !== initial.conversations) {
    setServerConversations(initial.conversations);
    setConversations(initial.conversations);
  }

  // A fresh server roster (it reads every chat's runs) replaces what open chats reported.
  if (botLive.source !== initial.bots) setBotLiveState({ source: initial.bots, byBot: {}, chats: {} });
  const setBotLive = useCallback((botId: string, patch: BotLive) => {
    setBotLiveState((cur) => {
      const prev = cur.byBot[botId] ?? {};
      const next = mergeBotLive(prev, patch);
      return next === prev ? cur : { ...cur, byBot: { ...cur.byBot, [botId]: next } };
    });
  }, []);
  const setChatStatus = useCallback((conversationId: string, botId: string, status: RosterStatus | null) => {
    setBotLiveState((cur) => {
      const prev = cur.chats[conversationId];
      if (status ? prev?.status === status && prev.botId === botId : !prev) return cur;
      const chats = { ...cur.chats };
      if (status) chats[conversationId] = { botId, status };
      else delete chats[conversationId];
      return { ...cur, chats };
    });
  }, []);
  const bots = useMemo(() => {
    const live = botLive.source === initial.bots ? botLive : { byBot: {} as Record<string, BotLive>, chats: {} as typeof botLive.chats };
    const chats = Object.values(live.chats);
    if (!workStatuses && !Object.keys(live.byBot).length && !chats.length) return initial.bots;
    return initial.bots.map((b) => {
      const status = mostUrgent([workStatuses ? workStatuses[b.id] : b.status, ...chats.filter((c) => c.botId === b.id).map((c) => c.status)]);
      return { ...b, ...live.byBot[b.id], status };
    });
  }, [initial.bots, botLive, workStatuses]);

  const sidebarOpen = useSyncExternalStore(subscribeSidebar, readSidebar, () => true);
  const setSidebarOpen = useCallback((v: boolean) => writeSidebar(v), []);

  const upsertConversation = useCallback((c: Partial<ConversationSummary> & { id: string }) => {
    setConversations((list) => {
      const idx = list.findIndex((x) => x.id === c.id);
      if (idx === -1) {
        // Stream patches cannot invent a missing chat's identity or title.
        if (c.title === undefined || c.botId === undefined || c.appId === undefined) return list;
        return [
          {
            title: "New chat",
            pinned: false,
            folderId: null,
            botId: null,
            appId: null,
            source: "chat",
            updatedAt: new Date().toISOString(),
            ...c,
          },
          ...list,
        ];
      }
      const next = [...list];
      next[idx] = { ...next[idx], ...c };
      return next;
    });
  }, []);

  const removeConversation = useCallback((id: string) => setConversations((l) => l.filter((c) => c.id !== id)), []);
  const setCurrentConversation = useCallback((c: ConversationSummary | null) => {
    setCurrent(c);
    if (c?.archived) removeConversation(c.id);
    else if (c) upsertConversation(c);
  }, [upsertConversation, removeConversation]);

  const value = useMemo(
    () => ({
      ...initial,
      bots,
      setBotLive,
      setChatStatus,
      serverBots: initial.bots,
      conversations,
      currentConversation,
      setCurrentConversation,
      sidebarOpen,
      setSidebarOpen,
      mobileOpen,
      setMobileOpen,
      searchOpen,
      setSearchOpen,
      upsertConversation,
      removeConversation,
    }),
    [initial, bots, setBotLive, setChatStatus, conversations, currentConversation, setCurrentConversation, sidebarOpen, setSidebarOpen, mobileOpen, searchOpen, upsertConversation, removeConversation],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
