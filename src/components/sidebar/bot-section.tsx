"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, Copy, Eye, EyeOff, GripVertical, Info, MessageSquare, MoreHorizontal, Pin, PinOff } from "lucide-react";
import { duplicateBot } from "@/app/(chat)/bots/actions";
import { BotAvatar } from "@/components/bots/bot-avatar";
import type { TargetOption } from "@/components/chat/types";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { StartSideChat } from "@/components/chat/start-side-chat";
import { cn } from "@/lib/utils";
import { shortTime } from "./group-by-date";
import { useShell } from "@/components/chat/shell-context";
import { MAX_UNPINNED, visibleNavigationBots } from "@/lib/bots/navigation";

/** Spread idle blinks so the roster doesn't blink in unison. */
function blinkDelay(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${-(Math.abs(h) % 6000)}ms`;
}

function BotRow({ b, active, onNavigate, previous, next, onMove, onDragStart, onDragEnd }: { b: TargetOption; active: boolean; onNavigate: () => void; previous?: TargetOption; next?: TargetOption; onMove: () => void; onDragStart: (event: React.DragEvent) => void; onDragEnd: () => void }) {
  const router = useRouter();
  const options = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const { navigationPending, changeNavigation } = useShell();
  const move = (target: TargetOption, placement: "before" | "after") => {
    onMove();
    changeNavigation({ kind: "move", botId: b.id, targetId: target.id, placement }, `Moved ${b.name} ${placement} ${target.name}`);
    requestAnimationFrame(() => options.current?.focus());
  };
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
      <button type="button" draggable={!navigationPending && !b.hidden} disabled={navigationPending || b.hidden}
        onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={() => setMenuOpen(true)}
        aria-label={`Reorder ${b.name}`} title="Drag to reorder, or open move actions"
        className="flex min-h-11 w-6 shrink-0 cursor-grab items-center justify-center rounded text-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 active:cursor-grabbing">
        <GripVertical className="h-4 w-4" />
      </button>
      <Link
        prefetch={false}
        href={`/?bot=${b.id}`}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
        title={b.label ? `${b.name} · ${b.label}` : b.name}
        className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5"
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
            {b.pinned && <Pin aria-label="Pinned" className="h-3 w-3 shrink-0 text-subtle" />}
            <span suppressHydrationWarning className="ml-auto hidden shrink-0 pl-1 text-[11px] tabular-nums text-subtle md:inline md:group-hover:invisible">
              {shortTime(b.lastAt)}
            </span>
          </span>
          {line && (
            <span className={cn("block truncate text-xs", status === "waiting" ? "text-warn" : status === "working" ? "text-working" : "text-muted")}>{line}</span>
          )}
        </span>
      </Link>
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger asChild>
          <button ref={options} className="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`${b.name} options`}>
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem asChild><StartSideChat botId={b.id} onCreated={onNavigate} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2" /></MenuItem>
          <MenuItem asChild><Link href={`/bots/${b.id}/chats`} onClick={onNavigate}><MessageSquare /> Chat history</Link></MenuItem>
          <MenuSeparator />
          <MenuItem disabled={navigationPending} onSelect={() => changeNavigation({ kind: "preference", botId: b.id, pinned: !b.pinned }, `${b.name} ${b.pinned ? "unpinned" : "pinned"}`)}>
            {b.pinned ? <PinOff /> : <Pin />} {b.pinned ? "Unpin" : "Pin"}
          </MenuItem>
          <MenuItem disabled={navigationPending || !previous || b.hidden} onSelect={() => previous && move(previous, "before")}><ArrowUp /> Move up</MenuItem>
          <MenuItem disabled={navigationPending || !next || b.hidden} onSelect={() => next && move(next, "after")}><ArrowDown /> Move down</MenuItem>
          <MenuItem disabled={navigationPending} onSelect={() => changeNavigation({ kind: "preference", botId: b.id, hidden: true }, `${b.name} hidden — its routines keep running`)}>
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

/** Personal ordering is independent of live activity and recent chat chronology. */
export function BotSection({ bots, activeBotId, onNavigate }: { bots: TargetOption[]; activeBotId?: string; onNavigate: () => void }) {
  const [showHidden, setShowHidden] = useState(false);
  const { navigationPending, navigationMessage, changeNavigation } = useShell();
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const pinned = bots.filter((b) => b.pinned && !b.hidden);
  const others = bots.filter((b) => !b.pinned && !b.hidden);
  const hidden = bots.filter((b) => b.hidden);
  // The last moved bot stays mounted past the limit until another move, so its focused row is never removed.
  const [moved, setMoved] = useState<string | null>(null);
  const visible = visibleNavigationBots(bots, activeBotId, moved);
  // Move up/down steps through the full saved order, including bots beyond the sidebar limit.
  const movable = bots.filter(b => !b.hidden);
  const cancelDrag = () => { setDragging(null); setDrop(null); };
  if (!bots.length) return null;
  return (
    <section className="mb-4" aria-label="Bot navigation">
      <p role="status" className={navigationPending ? "px-2.5 text-xs text-muted" : "sr-only"}>{navigationPending ? "Saving bot navigation…" : navigationMessage}</p>
      <div className="flex items-center gap-2 px-2.5 pb-1">
        <h3 className="flex-1 text-xs font-medium text-subtle">Bots</h3>
        {others.length > MAX_UNPINNED && (
          <Link href="/bots" onClick={onNavigate} className="text-xs text-subtle hover:text-fg">
            See all
          </Link>
        )}
      </div>
      {visible.map((b) => (
        <div key={b.id} data-navigation-bot={b.id}
          className={cn("relative", drop?.id === b.id && (drop.placement === "before" ? "before:absolute before:inset-x-0 before:top-0 before:border-t-2 before:border-accent" : "after:absolute after:inset-x-0 after:bottom-0 after:border-b-2 after:border-accent"), dragging === b.id && "opacity-50")}
          onDragOver={event => {
            if (!dragging || dragging === b.id || b.hidden || navigationPending) return;
            event.preventDefault(); event.dataTransfer.dropEffect = "move";
            const bounds = event.currentTarget.getBoundingClientRect();
            setDrop({ id: b.id, placement: event.clientY < bounds.y + bounds.height / 2 ? "before" : "after" });
          }}
          onDrop={event => {
            event.preventDefault();
            if (dragging && drop?.id === b.id && !navigationPending) {
              const source = bots.find(bot => bot.id === dragging);
              if (source) { setMoved(source.id); changeNavigation({ kind: "move", botId: dragging, targetId: b.id, placement: drop.placement }, `Moved ${source.name} ${drop.placement} ${b.name}`); }
            }
            cancelDrag();
          }}>
          <BotRow b={b} active={b.id === activeBotId} onNavigate={onNavigate} onMove={() => setMoved(b.id)}
            previous={movable[movable.findIndex(bot => bot.id === b.id) - 1]} next={movable[movable.findIndex(bot => bot.id === b.id) + 1]}
            onDragStart={event => { setDragging(b.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", b.id); }} onDragEnd={cancelDrag} />
        </div>
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
              <div key={b.id} className="flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm text-muted hover:bg-hover">
                <BotAvatar botId={b.id} value={b.icon} className="h-5 w-5 opacity-60" />
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                <button
                  disabled={navigationPending}
                  onClick={() => changeNavigation({ kind: "preference", botId: b.id, hidden: false }, `${b.name} shown`)}
                  className="flex min-h-11 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-bg hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
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
