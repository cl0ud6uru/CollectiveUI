"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Popover, Tooltip } from "radix-ui";
import { Bell, Bot, CircleAlert, Folder, LogOut, MoreHorizontal, PanelLeft, Search, Settings, Shield, SquarePen } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { useShell } from "@/components/chat/shell-context";
import type { TargetOption } from "@/components/chat/types";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tip } from "@/components/ui/tooltip";
import { botRailActivity, railNavigationBots } from "@/lib/bots/rail";
import { cn } from "@/lib/utils";
import { signOutAction } from "./sign-out";

const control = "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function RailControl({ label, href, onClick, icon: Icon, active, unread }: {
  label: string; href?: string; onClick?: () => void; icon: typeof Bot; active?: boolean; unread?: number;
}) {
  const contents = <><Icon className="h-5 w-5" aria-hidden="true" />{!!unread && <span aria-hidden="true" className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-blue-500" />}</>;
  const name = unread ? `${label}, ${unread} unread` : label;
  return <Tip label={name} side="right">
    {href ? <Link href={href} aria-label={name} aria-current={active ? "page" : undefined} className={cn(control, active && "bg-hover text-fg")}>{contents}</Link>
      : <button type="button" aria-label={label} onClick={onClick} className={control}>{contents}</button>}
  </Tip>;
}

function RailAvatar({ bot, activity }: { bot: TargetOption; activity: ReturnType<typeof botRailActivity> }) {
  return <span className="relative flex h-10 w-10 shrink-0 items-center justify-center">
    {activity.working && <span aria-hidden="true" data-rail-working className="absolute -inset-0.5 rounded-full border-2 border-working motion-safe:animate-pulse" />}
    <BotAvatar botId={bot.id} value={bot.icon} size={36} state={activity.approval ? "waiting" : activity.working ? "working" : "idle"}
      activity={activity.approval ? "approval" : activity.attention ? "attention" : activity.working ? "working" : "idle"} />
    {activity.unread && <span aria-hidden="true" data-rail-unread className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-sidebar" />}
    {activity.attention && <CircleAlert aria-hidden="true" data-rail-attention className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-sidebar text-amber-700 dark:text-amber-400" />}
  </span>;
}

export function AvatarRail() {
  const { bots, conversations, currentConversation, user, branding, inboxUnread, setSidebarOpen, setSearchOpen } = useShell();
  const pathname = usePathname();
  const activeId = pathname.startsWith("/c/") ? pathname.slice(3) : undefined;
  const current = currentConversation?.id === activeId ? currentConversation : conversations.find(c => c.id === activeId);
  const activeBotId = bots.some(bot => bot.id === current?.botId) ? current?.botId ?? undefined : undefined;
  const roster = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(6);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [query, setQuery] = useState("");
  const changeOverflowOpen = (open: boolean) => { setOverflowOpen(open); if (!open) setQuery(""); };
  useEffect(() => {
    const element = roster.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCapacity(Math.max(1, Math.min(6, Math.floor((entry.contentRect.height - 52) / 56)))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { all, visible, remaining } = railNavigationBots(bots, activeBotId, capacity);
  const filtered = all.filter(bot => `${bot.name} ${bot.label ?? ""} ${bot.description ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const initials = user.name.split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
  const expand = () => {
    setSidebarOpen(true);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('nav button[aria-label="Close sidebar"]')?.focus());
  };

  return <nav aria-label="Collapsed sidebar" className="hidden h-full w-[72px] shrink-0 flex-col items-center overflow-y-auto overflow-x-hidden border-r border-border bg-sidebar px-2 py-2 md:flex">
    <Tip label={branding.appName} side="right"><Link href="/" aria-label={branding.appName} className={cn(control, "mb-1 text-fg")}><BrandMark logoUrl={branding.logoUrl} logoEmoji={branding.logoEmoji} className="h-7 w-7 text-xl" /></Link></Tip>
    <div className="flex shrink-0 flex-col items-center">
      <RailControl label="Open sidebar" icon={PanelLeft} onClick={expand} />
      <RailControl label="New chat" icon={SquarePen} href="/" />
      <RailControl label="Search chats" icon={Search} onClick={() => setSearchOpen(true)} />
      <RailControl label="Hermes" icon={Bot} href="/hermes" active={pathname.startsWith("/hermes")} />
      <RailControl label="Bots" icon={Bot} href="/bots" active={pathname.startsWith("/bots")} />
      <RailControl label="Inbox" icon={Bell} href="/inbox" active={pathname === "/inbox"} unread={inboxUnread} />
    </div>
    <div ref={roster} className="mt-3 flex min-h-[116px] w-full flex-1 flex-col items-center overflow-y-auto overflow-x-hidden border-t border-border pt-2" aria-label="Bot navigation">
      {visible.map(bot => {
        const activity = botRailActivity(bot, conversations);
        return <Tooltip.Root key={bot.id}><Tooltip.Trigger asChild>
          <Link prefetch={false} href={`/?bot=${bot.id}`} data-rail-bot={bot.id} aria-label={`${bot.name}, ${activity.label}${activity.unread && activity.label !== "Unread result" ? ", Unread result" : ""}`} aria-current={bot.id === activeBotId ? "page" : undefined}
            className={cn("relative flex h-14 w-full shrink-0 items-center justify-center rounded-xl hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent", bot.id === activeBotId && "bg-hover before:absolute before:left-0 before:h-7 before:w-[3px] before:rounded-full before:bg-fg")}>
            <RailAvatar bot={bot} activity={activity} />
          </Link>
        </Tooltip.Trigger><Tooltip.Portal><Tooltip.Content side="right" sideOffset={12} collisionPadding={12} className="z-[60] w-64 rounded-xl border border-border bg-popover p-3 text-sm text-fg shadow-composer">
          <span className="flex items-center gap-2"><BotAvatar botId={bot.id} value={bot.icon} size={32} activity="decorative" /><span className="min-w-0"><span className="block truncate font-semibold">{bot.name}</span><span className={cn("block text-xs", activity.attention ? "text-warn" : activity.working ? "text-working" : "text-muted")}>{activity.label}{activity.unread && activity.label !== "Unread result" ? " · Unread result" : ""}</span></span></span>
          {bot.label && <span className="mt-2 block text-xs text-muted">{bot.label}</span>}{bot.preview && <span className="mt-2 block line-clamp-2">{bot.preview}</span>}<span className="mt-3 block text-xs text-muted">Open bot chat</span>
        </Tooltip.Content></Tooltip.Portal></Tooltip.Root>;
      })}
      {remaining > 0 && <Popover.Root open={overflowOpen} onOpenChange={changeOverflowOpen}>
        <Tip label={`All bots, ${remaining} more`} side="right"><Popover.Trigger asChild><button type="button" className={cn(control, "h-12 flex-col gap-0.5 data-[state=open]:bg-hover")} aria-label={`All bots, ${remaining} more`}><MoreHorizontal className="h-5 w-5" aria-hidden="true" /><span aria-hidden="true" className="text-[10px]">+{remaining}</span></button></Popover.Trigger></Tip>
        <Popover.Portal><Popover.Content side="right" align="end" sideOffset={12} collisionPadding={12} aria-label="All bots" className="z-50 flex max-h-[min(560px,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-6rem)] flex-col rounded-2xl border border-border bg-popover p-3 text-fg shadow-composer outline-none">
          <div className="flex items-center justify-between px-1 pb-3"><h2 className="font-semibold">All bots</h2><span className="rounded-full bg-hover px-2 text-xs text-muted">{all.length}</span></div>
          <label className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-bg px-3 focus-within:ring-2 focus-within:ring-accent"><Search aria-hidden="true" className="h-4 w-4 text-muted" /><input aria-label="Find a bot" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a bot…" className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
          <div className="mt-2 min-h-0 overflow-y-auto" aria-label="All bot results">
            {filtered.map(bot => {
              const activity = botRailActivity(bot, conversations);
              return <Link key={bot.id} prefetch={false} href={`/?bot=${bot.id}`} onClick={() => changeOverflowOpen(false)} aria-current={bot.id === activeBotId ? "page" : undefined} className="flex min-h-14 items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent">
                <RailAvatar bot={bot} activity={activity} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{bot.name}</span><span className={cn("block truncate text-xs", activity.attention ? "text-warn" : activity.working ? "text-working" : "text-muted")}>{activity.label}{activity.unread && activity.label !== "Unread result" ? " · Unread result" : ""}</span></span>
              </Link>;
            })}
            {!filtered.length && <p role="status" className="px-2 py-4 text-sm text-muted">No bots found</p>}
          </div>
          <Link href="/bots" onClick={() => changeOverflowOpen(false)} className="mt-2 flex min-h-11 shrink-0 items-center gap-2 rounded-lg border-t border-border px-2 text-sm text-muted hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"><Bot aria-hidden="true" className="h-4 w-4" />Manage bots</Link>
        </Popover.Content></Popover.Portal>
      </Popover.Root>}
    </div>
    <div className="mt-2 flex shrink-0 flex-col items-center border-t border-border pt-2">
      <RailControl label="Projects and chats" icon={Folder} onClick={expand} />
      <RailControl label="Settings" icon={Settings} href="/settings" active={pathname.startsWith("/settings")} />
      <Menu><Tip label={user.name} side="right"><MenuTrigger asChild><button type="button" aria-label={`${user.name} account`} className={control}><span className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-fg ring-1 ring-border">{initials}</span></button></MenuTrigger></Tip><MenuContent side="right" align="end">
        <MenuItem asChild><Link href="/settings"><Settings />Settings</Link></MenuItem>
        {user.isAdmin && <MenuItem asChild><Link href="/admin"><Shield />Admin panel</Link></MenuItem>}
        <MenuSeparator /><MenuItem onSelect={() => signOutAction()}><LogOut />Log out</MenuItem>
      </MenuContent></Menu>
    </div>
  </nav>;
}
