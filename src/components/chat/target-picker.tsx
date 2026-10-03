"use client";

import Link from "next/link";
import { Check, ChevronDown, LayoutGrid } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { TargetOption } from "./types";
import { BotAvatar } from "@/components/bots/bot-avatar";

/** "Your ChatGPT plan · unofficial", plus what to do when the plan isn't connected. */
function PlanNote({ plan }: { plan: NonNullable<TargetOption["personalPlan"]> }) {
  return (
    <span className="mt-0.5 block text-xs">
      <span className="rounded-full bg-amber-500/15 px-1.5 py-px text-amber-700 dark:text-amber-300">Your ChatGPT plan · unofficial</span>
      {plan.status !== "connected" && (
        <span className="ml-1 text-muted">{plan.status === "needs_reauth" ? "Reconnect in Settings" : "Connect in Settings first"}</span>
      )}
    </span>
  );
}

export function TargetPicker({
  value,
  apps,
  bots,
  onChange,
  locked,
}: {
  value: TargetOption | null;
  apps: TargetOption[];
  bots: TargetOption[];
  onChange: (t: TargetOption) => void;
  locked?: boolean;
}) {
  apps = apps.filter((a) => !a.hermes);
  const label = value?.name ?? "Select a model";
  if (locked && value?.kind === "bot") {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-lg font-medium">
        <BotAvatar botId={value.id} value={value.icon} size={24} className="h-6 w-6" />
        <span className="truncate">{label}</span>
      </div>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <button className="flex min-w-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-lg font-medium hover:bg-hover data-[state=open]:bg-hover">
          {value?.kind === "bot" && <BotAvatar botId={value.id} value={value.icon} size={24} className="mr-1 h-6 w-6" />}
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-[320px] max-w-[calc(100vw-2rem)]" align="start">
        {apps.length > 0 && <MenuLabel>Models</MenuLabel>}
        {apps.map((a) => (
          <MenuItem key={a.id} onSelect={() => onChange(a)} className="items-start py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{a.name}</span>
              {a.label && <span className="block truncate text-xs text-muted">{a.label}</span>}
              {a.description && <span className="block text-xs text-muted">{a.description}</span>}
              {a.personalPlan && <PlanNote plan={a.personalPlan} />}
            </span>
            {value?.kind === "app" && value.id === a.id && <Check className="mt-0.5" />}
          </MenuItem>
        ))}
        {bots.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Bots</MenuLabel>
            {bots.slice(0, 8).map((b) => (
              <MenuItem key={b.id} onSelect={() => onChange(b)} className="items-start py-2.5">
                <BotAvatar botId={b.id} value={b.icon} className="mt-0.5 h-5 w-5" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {b.name} {b.label && <span className="ml-1 text-xs font-normal text-subtle">{b.label}</span>}
                  </span>
                  {b.description && <span className="line-clamp-1 block text-xs text-muted">{b.description}</span>}
                </span>
                {value?.kind === "bot" && value.id === b.id && <Check className="mt-0.5" />}
              </MenuItem>
            ))}
          </>
        )}
        {apps.some((a) => a.personalPlan && a.personalPlan.status !== "connected") && (
          <MenuItem asChild>
            <Link href="/settings?tab=connected-accounts">Connect your ChatGPT plan…</Link>
          </MenuItem>
        )}
        <MenuSeparator />
        <MenuItem asChild>
          <Link href="/bots">
            <LayoutGrid /> Explore bots
          </Link>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
