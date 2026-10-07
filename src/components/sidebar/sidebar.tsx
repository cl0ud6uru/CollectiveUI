"use client";

import { BrandMark } from "@/components/brand-mark";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  Bell,
  Bot,
  ChevronRight,
  ChevronDown,
  LayoutGrid,
  MessageSquare,
  Folder,
  FolderOpen,
  LogOut,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Shield,
  SquarePen,
  Trash2,
  Users,
} from "lucide-react";
import {
  archiveConversation,
  createFolder,
  deleteConversation,
  deleteFolder,
  moveConversationToFolder,
  renameConversation,
  renameFolder,
  setConversationPinned,
} from "@/app/(chat)/actions";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { NewGroupDialog } from "@/components/bots/new-group-dialog";
import { useShell } from "@/components/chat/shell-context";
import type { ConversationSummary } from "@/components/chat/types";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuSubContent, MenuSubTrigger, MenuTrigger } from "@/components/ui/menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BotSection } from "./bot-section";
import { groupByDate } from "./group-by-date";
import { signOutAction } from "./sign-out";
import { TaskIndicator } from "./task-indicator";

function NavItem({
  href,
  onClick,
  icon: Icon,
  label,
  badge,
  active,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  badge?: number;
  active?: boolean;
}) {
  const cls = cn(
    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-hover",
    active && "bg-hover",
  );
  const inner = (
    <>
      <Icon className="h-[18px] w-[18px] shrink-0" />
      <span className="truncate">{label}</span>
      {!!badge && (
        <span className="ml-auto rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-5 text-accent-fg">{badge}</span>
      )}
    </>
  );
  return href ? (
    <Link href={href} className={cls} onClick={onClick}>
      {inner}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={onClick}>
      {inner}
    </button>
  );
}

const STACK_MAX = 3;

/** A group's member bots, lead first, overlapping like the mockup's chat heads. */
function MemberStack({ ids }: { ids: string[] }) {
  const { bots } = useShell();
  const members = ids.flatMap((id) => bots.find((b) => b.id === id) ?? []);
  if (!members.length) return null;
  const extra = members.length - STACK_MAX;
  return (
    <span className="ml-auto flex shrink-0 items-center pl-2" aria-hidden="true">
      {members.slice(0, STACK_MAX).map((b, i) => (
        <span key={b.id} className={cn("flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 ring-2 ring-sidebar", i > 0 && "-ml-1.5")}>
          <BotAvatar botId={b.id} value={b.icon} size={18} className="h-[18px] w-[18px]" />
        </span>
      ))}
      {extra > 0 && <span className="-ml-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-2 px-1 text-[10px] font-medium text-muted ring-2 ring-sidebar">+{extra}</span>}
    </span>
  );
}

function SectionHeader({ title, children, open, onToggle, controls }: { title: string; children?: React.ReactNode; open?: boolean; onToggle?: () => void; controls?: string }) {
  return (
    <div className="flex items-center gap-2 pl-2.5 pr-1">
      <h3 className="min-w-0 flex-1 text-xs font-medium text-muted">
        {onToggle ? <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={controls} className="flex min-h-8 w-full items-center gap-2 rounded-md text-left hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
          <ChevronDown aria-hidden className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />{title}
        </button> : title}
      </h3>
      {children}
    </div>
  );
}

const AddButton = ({ label, ...props }: { label: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <Tip label={label}>
    <button type="button" className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg" aria-label={label} {...props}>
      <Plus className="h-4 w-4" />
    </button>
  </Tip>
);

function ConversationItem({ c, active, recent = false }: { c: ConversationSummary; active: boolean; recent?: boolean }) {
  const { folders, bots, upsertConversation, removeConversation, setMobileOpen } = useShell();
  const router = useRouter();
  const stacked = !!c.isGroup && !!c.memberBotIds?.some((id) => bots.some((b) => b.id === id));
  const isCurrent = usePathname() === `/c/${c.id}`;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(c.title);

  async function commitRename() {
    setEditing(false);
    const t = title.trim();
    if (!t || t === c.title) return setTitle(c.title);
    upsertConversation({ id: c.id, title: t });
    await renameConversation(c.id, t).catch(() => toast.error("Rename failed"));
  }

  if (editing) {
    return (
      <div className="px-1">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setTitle(c.title);
              setEditing(false);
            }
          }}
          className="h-9 w-full rounded-lg border border-border bg-bg px-2 text-sm outline-none"
        />
      </div>
    );
  }

  return (
    <div className={cn("group relative flex h-9 items-center rounded-lg hover:bg-hover", active && "bg-hover")}>
      <Link
        href={`/c/${c.id}`}
        aria-current={active ? "page" : undefined}
        onClick={() => setMobileOpen(false)}
        className={cn("flex min-w-0 flex-1 items-center gap-2 overflow-hidden whitespace-nowrap px-2.5 text-sm", !(recent && c.taskActivity) && !stacked && "fade-end")}
        title={c.title}
      >
        {c.source === "routine" && <Bot className="h-3.5 w-3.5 shrink-0 text-subtle" />}
        {recent && c.source !== "routine" && <MessageSquare aria-hidden className="h-3.5 w-3.5 shrink-0 text-subtle" />}
        {c.isBotHome && <span className="shrink-0 text-[10px] text-subtle">Home</span>}
        {c.isGroup && !stacked && <Users className="h-3.5 w-3.5 shrink-0 text-subtle" />}
        <span className={cn("min-w-0", ((recent && c.taskActivity) || stacked) && "truncate")}>{c.title}</span>
        {recent && <TaskIndicator activity={c.taskActivity} />}
        {stacked && <MemberStack ids={c.memberBotIds!} />}
      </Link>
      <Menu>
        <MenuTrigger asChild>
          <button
            className={cn(
              "mr-1 rounded-md p-1 text-muted opacity-0 hover:text-fg group-hover:opacity-100 data-[state=open]:opacity-100",
              active && "opacity-100",
            )}
            aria-label="Chat options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem
            onSelect={async () => {
              upsertConversation({ id: c.id, pinned: !c.pinned });
              await setConversationPinned(c.id, !c.pinned);
            }}
          >
            {c.pinned ? <PinOff /> : <Pin />} {c.pinned ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Rename
          </MenuItem>
          <MenuSub>
            <MenuSubTrigger>
              <Folder /> Move to project <ChevronRight className="ml-auto" />
            </MenuSubTrigger>
            <MenuSubContent>
              {folders.map((f) => (
                <MenuItem
                  key={f.id}
                  onSelect={async () => {
                    upsertConversation({ id: c.id, folderId: f.id });
                    await moveConversationToFolder(c.id, f.id);
                  }}
                >
                  <Folder /> {f.name}
                </MenuItem>
              ))}
              {c.folderId && (
                <MenuItem
                  onSelect={async () => {
                    upsertConversation({ id: c.id, folderId: null });
                    await moveConversationToFolder(c.id, null);
                  }}
                >
                  Remove from project
                </MenuItem>
              )}
              {!folders.length && <div className="px-2.5 py-2 text-xs text-subtle">No projects yet</div>}
            </MenuSubContent>
          </MenuSub>
          <MenuItem
            onSelect={async () => {
              removeConversation(c.id);
              await archiveConversation(c.id);
              toast.success("Chat archived");
              if (isCurrent) router.push("/");
            }}
          >
            <Archive /> Archive
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            onSelect={async () => {
              if (!confirm(`Delete "${c.title}"?`)) return;
              removeConversation(c.id);
              await deleteConversation(c.id);
              if (isCurrent) router.push("/");
            }}
          >
            <Trash2 /> Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

function FolderItem({ folder, convs, activeId }: { folder: { id: string; name: string }; convs: ConversationSummary[]; activeId?: string }) {
  const [open, setOpen] = useState(convs.some((c) => c.id === activeId));
  return (
    <div>
      <div className="group flex h-9 items-center rounded-lg hover:bg-hover">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 text-sm">
          {open ? <FolderOpen className="h-[18px] w-[18px] shrink-0" /> : <Folder className="h-[18px] w-[18px] shrink-0" />}
          <span className="truncate">{folder.name}</span>
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button className="mr-1 rounded-md p-1 text-muted opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100" aria-label="Project options">
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              onSelect={async () => {
                const name = prompt("Rename project", folder.name);
                if (name?.trim()) await renameFolder(folder.id, name.trim());
              }}
            >
              <Pencil /> Rename
            </MenuItem>
            <MenuItem
              danger
              onSelect={async () => {
                if (confirm(`Delete project "${folder.name}"? Chats inside are kept.`)) await deleteFolder(folder.id);
              }}
            >
              <Trash2 /> Delete project
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {open && (
        <div className="ml-4 border-l border-border pl-1">
          {convs.length ? (
            convs.map((c) => <ConversationItem key={c.id} c={c} active={c.id === activeId} />)
          ) : (
            <div className="px-2.5 py-1.5 text-xs text-subtle">No chats yet</div>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const shell = useShell();
  const { user, branding, conversations, currentConversation, folders, bots, inboxUnread, setSidebarOpen, setSearchOpen, setMobileOpen } = shell;
  const pathname = usePathname();
  const [groupsOpen, setGroupsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(folders.length > 0);
  const [recentOpen, setRecentOpen] = useState(true);
  const [allHistory, setAllHistory] = useState(false);
  const activeId = pathname.startsWith("/c/") ? pathname.slice(3) : undefined;
  const current = currentConversation?.id === activeId ? currentConversation : conversations.find((c) => c.id === activeId);
  const activeBotId = current?.isBotHome && bots.some((b) => b.id === current.botId) ? current.botId ?? undefined : undefined;
  const historyActiveId = activeBotId ? undefined : activeId;

  const { pinned, groups, grouped, byFolder } = useMemo(() => {
    const byFolder = new Map<string, ConversationSummary[]>();
    const loose: ConversationSummary[] = [];
    const pinned: ConversationSummary[] = [];
    const groups: ConversationSummary[] = [];
    for (const c of conversations) {
      if (c.archived) continue;
      if (c.folderId) {
        const l = byFolder.get(c.folderId) ?? [];
        l.push(c);
        byFolder.set(c.folderId, l);
      } else if (c.isGroup) groups.push(c);
      else if (c.pinned) pinned.push(c);
      // Homes live in the bot roster. Keep inaccessible/hidden-bot history reachable, and respect explicit shortcuts.
      else if (!(c.isBotHome && bots.some((b) => b.id === c.botId && (!b.hidden || b.id === activeBotId)))) loose.push(c);
    }
    return { pinned, groups, grouped: groupByDate(loose), byFolder };
  }, [conversations, bots, activeBotId]);
  const recent = grouped.flatMap(g => g.items);
  const visibleRecent = allHistory ? recent : recent.filter((c, i) => i < 2 || c.id === historyActiveId);

  const initials = user.name
    .split(/\s+/)
    .map((s) => s[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <nav aria-label="Main navigation" className="flex h-full w-[300px] max-w-[100vw] flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <Link href="/" className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1 text-lg font-semibold hover:bg-hover" onClick={() => setMobileOpen(false)}>
          <BrandMark logoUrl={branding.logoUrl} logoEmoji={branding.logoEmoji} className="h-7 w-7 text-xl" />
          <span className="truncate text-base">{branding.appName}</span>
        </Link>
        <Tip label="Close sidebar">
          <button
            onClick={() => {
              setSidebarOpen(false);
              setMobileOpen(false);
            }}
            className="rounded-lg p-2 text-muted hover:bg-hover hover:text-fg"
            aria-label="Close sidebar"
          >
            <PanelLeft className="h-5 w-5" />
          </button>
        </Tip>
      </div>

      <div className="shrink-0 space-y-0.5 px-2">
        <NavItem href="/" icon={SquarePen} label="New chat" onClick={() => setMobileOpen(false)} />
        <NavItem onClick={() => setSearchOpen(true)} icon={Search} label="Search chats" />
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <BotSection bots={bots} activeBotId={activeBotId} onNavigate={() => setMobileOpen(false)} />

        {(bots.length > 1 || groups.length > 0) && (
          <section className="mb-2" aria-label="Groups">
            <SectionHeader title="Groups" open={groupsOpen} onToggle={() => setGroupsOpen(v => !v)} controls="sidebar-groups">
              {bots.length > 1 && <NewGroupDialog bots={bots} onCreated={() => setMobileOpen(false)} trigger={<AddButton label="New group chat" />} />}
            </SectionHeader>
            <div id="sidebar-groups" hidden={!groupsOpen}>
            {groups.map((c) => (
              <ConversationItem key={c.id} c={c} active={c.id === historyActiveId} />
            ))}
            {!groups.length && <p className="px-2.5 py-1.5 text-sm text-subtle">No groups yet</p>}
            </div>
          </section>
        )}

        <section className="mb-2" aria-label="Projects">
          <SectionHeader title="Projects" open={projectsOpen} onToggle={() => setProjectsOpen(v => !v)} controls="sidebar-projects">
            <AddButton
              label="New project"
              onClick={async () => {
                const name = prompt("Project name");
                if (name?.trim()) { await createFolder(name.trim()); setProjectsOpen(true); }
              }}
            />
          </SectionHeader>
          <div id="sidebar-projects" hidden={!projectsOpen}>
          {folders.map((f) => (
            <FolderItem key={f.id} folder={f} convs={byFolder.get(f.id) ?? []} activeId={historyActiveId} />
          ))}
          {!folders.length && <p className="px-2.5 py-1.5 text-sm text-subtle">No projects yet</p>}
          </div>
        </section>

        {pinned.length > 0 && (
          <section className="mb-4">
            <h3 className="px-2.5 pb-1 text-xs font-medium text-subtle">Pinned</h3>
            {pinned.map((c) => (
              <ConversationItem key={c.id} c={c} active={c.id === historyActiveId} />
            ))}
          </section>
        )}

        {recent.length > 0 && (
          <section className="mb-2" aria-label="Recent chats">
            <SectionHeader title={`Recent chats · ${recent.length}`} open={recentOpen} onToggle={() => setRecentOpen(v => !v)} controls="sidebar-recent" />
            <div id="sidebar-recent" hidden={!recentOpen}>
            {visibleRecent.map((c) => (
              <ConversationItem key={c.id} c={c} active={c.id === historyActiveId} recent />
            ))}
            {recent.length > 2 && <button type="button" onClick={() => setAllHistory(v => !v)} aria-expanded={allHistory} className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent">
              <ChevronRight aria-hidden className={cn("h-3.5 w-3.5", allHistory && "rotate-90")} />{allHistory ? "Show less history" : "See all history"}
            </button>}
            </div>
          </section>
        )}
        {!pinned.length && !grouped.length && !byFolder.size && !groups.length && <p className="px-2.5 text-xs text-subtle">Side chats and previous homes will appear here.</p>}
      </div>

      <div className="shrink-0 px-2 pb-2">
        <NavItem href="/bots" icon={LayoutGrid} label="Browse bots" active={pathname.startsWith("/bots")} onClick={() => setMobileOpen(false)} />
        <NavItem href="/inbox" icon={Bell} label="Inbox" badge={inboxUnread} active={pathname === "/inbox"} onClick={() => setMobileOpen(false)} />
      </div>
      <div className="shrink-0 border-t border-border p-2">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm hover:bg-hover">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg ring-1 ring-border">
                {initials}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{user.name}</span>
                <span className="block truncate text-xs text-subtle">{user.email}</span>
              </span>
              <Settings aria-hidden className="h-4 w-4 shrink-0 text-muted" />
            </button>
          </MenuTrigger>
          <MenuContent side="top" align="start" className="w-[240px]">
            <MenuItem asChild>
              <Link href="/settings" onClick={() => setMobileOpen(false)}>
                <Settings /> Settings
              </Link>
            </MenuItem>
            {user.isAdmin && (
              <MenuItem asChild>
                <Link href="/admin" onClick={() => setMobileOpen(false)}>
                  <Shield /> Admin panel
                </Link>
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem onSelect={() => signOutAction()}>
              <LogOut /> Log out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </nav>
  );
}
