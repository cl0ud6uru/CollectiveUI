"use client";

import Link from "next/link";
import { useState } from "react";
import { Search } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";

type Card = { id: string; name: string; avatar: string | null; label: string | null; description: string | null; visibility: string };

function BotCard({ b, mine }: { b: Card; mine?: boolean }) {
  return (
    <div className="group flex gap-4 rounded-2xl p-4 hover:bg-surface-2">
      <Link prefetch={false} href={`/?bot=${b.id}`} aria-label={`Chat with ${b.name}`} className="flex h-14 w-14 shrink-0 items-center justify-center">
        <BotAvatar botId={b.id} value={b.avatar} size={56} className="h-14 w-14" />
      </Link>
      <div className="min-w-0 flex-1">
        <Link prefetch={false} href={`/?bot=${b.id}`} className="flex items-center gap-2 font-semibold hover:underline">
          <span className="truncate">{b.name}</span>
          {b.label && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-normal text-muted group-hover:bg-bg">{b.label}</span>}
        </Link>
        <p className="line-clamp-2 text-sm text-muted">{b.description || "No description"}</p>
        <div className="mt-1 flex gap-3 text-xs text-subtle">
          <span className="capitalize">{b.visibility === "org" ? "Everyone" : b.visibility === "groups" ? "Groups" : "Only me"}</span>
          <Link href={`/bots/${b.id}`} className="hover:text-fg hover:underline">
            Details
          </Link>
          {mine && (
            <Link href={`/bots/${b.id}/edit`} className="hover:text-fg hover:underline">
              Edit
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

export function BotGrid({ mine, others }: { mine: Card[]; others: Card[] }) {
  const [q, setQ] = useState("");
  const f = (l: Card[]) => l.filter((b) => (b.name + " " + (b.description ?? "")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="mb-8 flex max-w-xl items-center gap-3 rounded-full bg-surface-2 px-4">
        <Search className="h-5 w-5 text-subtle" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bots" aria-label="Search bots" className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" />
      </div>
      {f(mine).length > 0 && (
        <section className="mb-10">
          <h2 className="mb-2 text-base font-semibold">My bots</h2>
          <div className="grid gap-2 md:grid-cols-2">{f(mine).map((b) => <BotCard key={b.id} b={b} mine />)}</div>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-base font-semibold">Available to you</h2>
        {f(others).length ? (
          <div className="grid gap-2 md:grid-cols-2">{f(others).map((b) => <BotCard key={b.id} b={b} />)}</div>
        ) : (
          <p className="text-sm text-muted">No shared bots yet.</p>
        )}
      </section>
    </div>
  );
}
