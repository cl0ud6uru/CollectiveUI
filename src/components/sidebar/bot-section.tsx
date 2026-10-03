"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Copy, Eye, EyeOff, Info, MessageSquare, MoreHorizontal, Pin, PinOff, Users } from "lucide-react";
import { duplicateBot, setBotSidebarPref } from "@/app/(chat)/bots/actions";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { NewGroupDialog } from "@/components/bots/new-group-dialog";
import type { TargetOption } from "@/components/chat/types";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { StartSideChat } from "@/components/chat/start-side-chat";
import { cn } from "@/lib/utils";
import { shortTime } from "./group-by-date";

const MAX_UNPINNED = 5;

/** Spread idle blinks so the roster doesn't blink in unison. */
function blinkDelay(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${-(Math.abs(h) % 6000)}ms`;
}

function BotRow({ b, active, onNavigate }: { b: TargetOption; active: boolean; onNavigate: () => void }) {
  const router = useRouter();
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };
  const status = b.status ?? null;
  const line = status === "waiting" ? "Needs your approval" : status === "working" ? "Working…" : (b.preview || (b.coordinator ? "Default coordinator" : b.label) || b.description || "");
  return (
    <div className={cn("group relative flex items-center rounded-lg hover:bg-hover", active && "bg-hover")}>
      <Link
        prefetch={false}
        href={`/?bot=${b.id}`}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
        title={b.label ? `${b.name} · ${b.label}` : b.name}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5"
      >
        <span className="relative shrink-0" style={{ ["--blink-delay" as string]: blinkDelay(b.id) }}>
          <BotAvatar botId={b.id} activity={status === "waiting" ? "approval" : status === "working" ? "working" : undefined} value={b.icon} size={32} state={status ?? "idle"} className="h-8 w-8 [&_.blob-eyes]:[animation-delay:var(--blink-delay)]" />
          {status && (
            <span
              aria-hidden
              className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-sidebar", status === "waiting" ? "bg-warn" : "bg-working motion-safe:animate-pulse")}
            />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn("truncate text-sm", active && "font-medium")}>{b.name}</span>
            {b.pinned && <Pin className="h-3 w-3 shrink-0 text-subtle" />}
            <span suppressHydrationWarning className="ml-auto hidden shrink-0 pl-1 text-[11px] tabular-nums text-subtle md:inline md:group-hover:invisible">
              {shortTime(b.lastAt)}
            </span>
          </span>
          {line && (
            <span className={cn("block truncate text-xs", status === "waiting" ? "text-warn" : status === "working" ? "text-working" : "text-muted")}>{line}</span>
          )}
        </span>
      </Link>
      <Menu>
        <MenuTrigger asChild>
          <button className="absolute right-1 top-1 rounded-md p-1 text-muted hover:text-fg md:opacity-0 md:group-hover:opacity-100 data-[state=open]:opacity-100" aria-label={`${b.name} options`}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem asChild><StartSideChat botId={b.id} onCreated={onNavigate} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2" /></MenuItem>
          <MenuItem asChild><Link href={`/bots/${b.id}/chats`} onClick={onNavigate}><MessageSquare /> Chat history</Link></MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={() => act(() => setBotSidebarPref(b.id, { pinned: !b.pinned }))}>
            {b.pinned ? <PinOff /> : <Pin />} {b.pinned ? "Unpin" : "Pin to top"}
          </MenuItem>
          <MenuItem onSelect={() => act(() => setBotSidebarPref(b.id, { hidden: true }), `${b.name} hidden — its routines keep running`)}>
            <EyeOff /> Hide from sidebar
          </MenuItem>
          <MenuSeparator />
          <MenuItem asChild>
            <Link href={`/bots/${b.id}`} onClick={onNavigate}>
              <Info /> Details
            </Link>
          </MenuItem>
          <MenuItem
            onSelect={() =>
              act(async () => {
                const { id } = await duplicateBot(b.id);
                router.push(`/bots/${id}/edit`);
              }, "Duplicated — routines were copied paused")
            }
          >
            <Copy /> Duplicate
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}

/** Sidebar bots: pinned first, a stable roster, and a collapsible "Hidden Bots" section. */
export function BotSection({ bots, activeBotId, onNavigate }: { bots: TargetOption[]; activeBotId?: string; onNavigate: () => void }) {
  const [showHidden, setShowHidden] = useState(false);
  const pinned = bots.filter((b) => b.pinned && !b.hidden);
  const others = bots.filter((b) => !b.pinned && !b.hidden).sort((a, b) => Number(!!b.coordinator) - Number(!!a.coordinator));
  const hidden = bots.filter((b) => b.hidden);
  const visible = [...pinned, ...others.slice(0, MAX_UNPINNED)];
  const current = bots.find((b) => b.id === activeBotId);
  // Keep an opened home discoverable without changing pinned/hidden preferences or reordering other bots.
  if (current && !visible.some((b) => b.id === current.id)) visible.push(current);
  if (!bots.length) return null;
  return (
    <section className="mb-4">
      <div className="flex items-center gap-2 px-2.5 pb-1">
        <h3 className="flex-1 text-xs font-medium text-subtle">Bots</h3>
        {others.length > MAX_UNPINNED && (
          <Link href="/bots" onClick={onNavigate} className="text-xs text-subtle hover:text-fg">
            See all
          </Link>
        )}
        {bots.length > 1 && (
          <NewGroupDialog
            bots={bots}
            onCreated={onNavigate}
            trigger={
              <button className="rounded p-0.5 text-subtle hover:bg-hover hover:text-fg" aria-label="New group chat" title="New group chat">
                <Users className="h-3.5 w-3.5" />
              </button>
            }
          />
        )}
      </div>
      {visible.map((b) => (
        <BotRow key={b.id} b={b} active={b.id === activeBotId} onNavigate={onNavigate} />
      ))}
      {hidden.length > 0 && (
        <>
          <button
            onClick={() => setShowHidden((v) => !v)}
            className="mt-1 flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-xs text-subtle hover:bg-hover"
          >
            {pinned.length + others.length === 0 ? "Show Hidden Bots" : "Hidden Bots"}
            <span className="rounded-full bg-hover px-1.5">{hidden.length}</span>
            <ChevronDown className={cn("ml-auto h-3.5 w-3.5 transition", showHidden && "rotate-180")} />
          </button>
          {showHidden &&
            hidden.map((b) => (
              <div key={b.id} className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted hover:bg-hover">
                <BotAvatar botId={b.id} value={b.icon} className="h-5 w-5 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                <button
                  onClick={() => setBotSidebarPref(b.id, { hidden: false })}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-bg hover:text-fg"
                >
                  <Eye className="h-3.5 w-3.5" /> Unhide
                </button>
              </div>
            ))}
        </>
      )}
    </section>
  );
}
