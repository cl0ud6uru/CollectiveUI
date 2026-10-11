"use client";

import { Popover } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { LeadBadge } from "@/components/bots/lead-badge";
import type { TargetOption } from "./types";

export function GroupMembers({ members }: { members: TargetOption[] }) {
  return <ul className="space-y-2" aria-label="Group members">
    {members.map((member, index) => <li key={member.id} className="flex min-w-0 items-center gap-2">
      <BotAvatar botId={member.id} value={member.icon} size={24} className="h-6 w-6" />
      <span className="min-w-0 flex-1 text-sm wrap-anywhere">{member.name}</span>
      {index === 0 && <LeadBadge />}
    </li>)}
  </ul>;
}

/** Members arrive in the server's persisted order: the lead is always first. */
export function GroupHeader({ group }: { group: TargetOption }) {
  const members = group.members ?? [];
  const lead = members[0];
  return <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2.5 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-fg"
        aria-label={`Group members: ${group.name}${lead ? `. Lead: ${lead.name}` : ""}`}>
        <div className="hidden shrink-0 -space-x-2 sm:flex" aria-hidden="true">
          {members.slice(0, 4).map(member => <span key={member.id} className="rounded-full bg-bg p-px">
            <BotAvatar botId={member.id} value={member.icon} size={24} className="h-6 w-6" />
          </span>)}
        </div>
        <span className="min-w-0 text-left">
          <span className="block truncate text-sm font-medium">{group.name}</span>
          {lead && <span className="flex items-center gap-1.5"><LeadBadge /><span className="truncate text-xs text-muted">{lead.name}</span></span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={16}
        className="z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover p-4 shadow-xl" aria-label="Group members">
        <GroupMembers members={members} />
        <p className="mt-3 text-xs text-muted">Messages without an @mention go to the lead bot. Use @mentions to address other members.</p>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
