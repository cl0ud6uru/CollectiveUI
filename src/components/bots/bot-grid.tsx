"use client";

import Link from "next/link";
import { useState } from "react";
import { Globe, Lock, Pin, Search, Users, X } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { useShell } from "@/components/chat/shell-context";
import { cn } from "@/lib/utils";

type Card = { id: string; name: string; avatar: string | null; label: string | null; description: string | null; visibility: string };

const AUDIENCE = {
  org: { icon: Globe, text: "Everyone" },
  groups: { icon: Users, text: "Groups" },
  private: { icon: Lock, text: "Only me" },
} as const;

/** The whole tile opens the bot's chat (a stretched link); Pin, Details and Edit sit above it. */
function BotCard({ b, mine }: { b: Card; mine?: boolean }) {
  const { bots, navigationPending, changeNavigation } = useShell();
  const bot = bots.find(bot => bot.id === b.id);
  const audience = AUDIENCE[b.visibility as keyof typeof AUDIENCE] ?? AUDIENCE.private;
  const action = "relative z-10 rounded-md px-1.5 py-1 hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div className="group relative flex flex-col rounded-2xl border border-border bg-surface p-4 transition-colors hover:bg-surface-2 has-[a[data-primary]:focus-visible]:outline-2 has-[a[data-primary]:focus-visible]:outline-accent">
      <div className="flex items-start gap-3">
        <Link
          prefetch={false}
          href={`/?bot=${b.id}`}
          aria-label={`Chat with ${b.name}`}
          data-primary
          className="flex min-w-0 flex-1 items-center gap-3 outline-none after:absolute after:inset-0 after:rounded-2xl"
        >
          <BotAvatar botId={b.id} value={b.avatar} size={48} className="h-12 w-12" />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{b.name}</span>
            {b.label && <span className="block truncate text-xs text-muted">{b.label}</span>}
          </span>
        </Link>
        {bot && <button
          type="button"
          aria-label={`${bot.pinned ? "Unpin" : "Pin"} ${b.name}`}
          aria-pressed={!!bot.pinned}
          title={bot.pinned ? "Pinned to sidebar" : "Pin to sidebar"}
          disabled={navigationPending}
          onClick={() => changeNavigation({ kind: "preference", botId: b.id, pinned: !bot.pinned }, `${b.name} ${bot.pinned ? "unpinned" : "pinned"}`)}
          className={cn(
            "relative z-10 -mr-2 -mt-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50",
            bot.pinned ? "text-fg" : "text-subtle [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
          )}
        >
          <Pin className={cn("h-4 w-4", bot.pinned && "fill-current")} />
        </button>}
      </div>
      <p className={cn("mt-3 line-clamp-2 min-h-10 text-sm", b.description ? "text-muted" : "text-subtle italic")}>{b.description || "No description yet"}</p>
      <div className="mt-3 flex items-center gap-1 text-xs text-subtle">
        <span className="mr-auto inline-flex items-center gap-1.5">
          <audience.icon className="h-3.5 w-3.5" aria-hidden="true" />
          {audience.text}
        </span>
        <Link href={`/bots/${b.id}`} className={action}>
          Details
        </Link>
        {mine && (
          <Link href={`/bots/${b.id}/edit`} className={action}>
            Edit
          </Link>
        )}
      </div>
    </div>
  );
}

function Section({ title, bots, mine, empty }: { title: string; bots: Card[]; mine?: boolean; empty?: string }) {
  if (!bots.length && !empty) return null;
  return (
    <section className="mb-10">
      <h2 className="mb-3 flex items-baseline gap-2 text-base font-semibold">
        {title}
        {bots.length > 0 && <span className="text-sm font-normal text-subtle">{bots.length}</span>}
      </h2>
      {bots.length ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{bots.map((b) => <BotCard key={b.id} b={b} mine={mine} />)}</div>
      ) : (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">{empty}</p>
      )}
    </section>
  );
}

export function BotGrid({ mine, others }: { mine: Card[]; others: Card[] }) {
  const [q, setQ] = useState("");
  const { navigationPending, navigationMessage } = useShell();
  const needle = q.trim().toLowerCase();
  const f = (l: Card[]) => l.filter((b) => [b.name, b.label, b.description].join(" ").toLowerCase().includes(needle));
  const shownMine = f(mine);
  const shownOthers = f(others);
  return (
    <div>
      <p role="status" className={navigationPending ? "mb-2 text-xs text-muted" : "sr-only"}>{navigationPending ? "Saving bot navigation…" : navigationMessage}</p>
      <div className="mb-8 flex max-w-xl items-center gap-3 rounded-full border border-transparent bg-surface-2 pl-4 pr-1 focus-within:border-fg/40">
        <Search className="h-5 w-5 shrink-0 text-subtle" aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} placeholder="Search bots" aria-label="Search bots" className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
        {q && (
          <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-hover hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {needle && !shownMine.length && !shownOthers.length ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted">No bots match “{q.trim()}”.</p>
      ) : (
        <>
          <Section title="My bots" bots={shownMine} mine />
          <Section title="Available to you" bots={shownOthers} empty={needle ? undefined : "No one has shared a bot with you yet."} />
        </>
      )}
    </div>
  );
}
