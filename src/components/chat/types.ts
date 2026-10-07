export type ConversationSummary = {
  id: string;
  title: string;
  pinned: boolean;
  folderId: string | null;
  botId: string | null;
  appId: string | null;
  source: "chat" | "routine" | "delegation";
  isGroup?: boolean;
  /** group chats: member bot ids, lead first */
  memberBotIds?: string[];
  isBotHome?: boolean;
  archived?: boolean;
  updatedAt: string; // ISO
  taskActivity?: { status: import("@/lib/runs/types").AgentRunStatus; unread: boolean };
};

export type FolderSummary = { id: string; name: string };

export type TargetOption = {
  kind: "app" | "bot" | "group";
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  supportsVision?: boolean;
  /** Display hint only; command APIs resolve and authorize the backend again. */
  hermes?: boolean;
  /** Display hint only. Team APIs authorize the current audience and maintainer membership. */
  hermesTeam?: boolean;
  starters?: string[];
  label?: string | null;
  pinned?: boolean;
  coordinator?: boolean;
  hidden?: boolean;
  /** Latest committed user message in a direct chat; activity/preview timestamps never affect navigation. */
  lastSentAt?: string | null;
  /** Bot roster: the home chat's latest line, when it changed, and whether the bot is busy for this person. */
  preview?: string | null;
  lastAt?: string | null;
  status?: "working" | "waiting" | null;
  /** group chats: member bots, lead first */
  members?: TargetOption[];
  /** Apps that run on the person's own ChatGPT plan, and whether they've connected it. */
  personalPlan?: { provider: "chatgpt"; status: "connected" | "not_connected" | "needs_reauth" };
};

export type Branding = { appName: string; welcomeText: string; logoEmoji: string; logoUrl?: string | null };

export type CurrentUser = { id: string; name: string; email: string | null; isAdmin: boolean; canCreateBots: boolean };
