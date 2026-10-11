"use client";

import { useRouter } from "next/navigation";
import { useId, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { createGroupChat } from "@/app/(chat)/bots/actions";
import type { TargetOption } from "@/components/chat/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { LeadBadge } from "@/components/bots/lead-badge";
import { emptyGroupSelection, groupMemberOrder, groupSelectionReducer } from "@/lib/group-selection";

/** Pick 2–6 members, then explicitly choose which one leads. */
export function NewGroupDialog({ bots, trigger, onCreated }: { bots: TargetOption[]; trigger: React.ReactNode; onCreated?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selection, dispatch] = useReducer(groupSelectionReducer, emptyGroupSelection);
  const { picked, leadId } = selection;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const leadChoiceId = useId();
  const nameId = useId();
  const orderedMembers = groupMemberOrder(selection);
  const selectedBots = picked.map(id => bots.find(bot => bot.id === id)).filter(bot => bot !== undefined);

  function reset() {
    dispatch({ type: "reset" });
    setName("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting.current) return;
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title="New group chat" description="Pick two to six bots, then choose a lead." hideClose={busy}>
        <fieldset disabled={busy} className="min-w-0 max-h-56 space-y-1 overflow-y-auto">
          <legend className="sr-only">Group members</legend>
          {bots.map((b) => {
            const selected = picked.includes(b.id);
            return (
              <label
                key={b.id}
                className={cn("flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover focus-within:outline-2 focus-within:outline-offset-[-2px] focus-within:outline-fg", selected && "bg-hover")}
              >
                <BotAvatar botId={b.id} value={b.icon} size={28} className="h-7 w-7" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{b.name}</span>
                  {b.label && <span className="block truncate text-xs text-muted">{b.label}</span>}
                </span>
                {leadId === b.id && <LeadBadge />}
                <input type="checkbox" checked={selected} disabled={!selected && picked.length >= 6}
                  aria-label={b.name} className="h-5 w-5 shrink-0 accent-fg"
                  onChange={() => dispatch({ type: "toggle", id: b.id })} />
              </label>
            );
          })}
          {!bots.length && <p className="text-sm text-muted">You don&apos;t have any bots yet.</p>}
        </fieldset>
        <fieldset disabled={busy || !picked.length} className="mt-4 min-w-0" aria-describedby={`${leadChoiceId}-hint`}>
          <legend className="text-sm font-semibold">Lead bot</legend>
          <p id={`${leadChoiceId}-hint`} className="mt-1 text-sm text-muted">Messages without an @mention go to the lead bot.</p>
          <div className="mt-2 grid gap-1 sm:grid-cols-2">
            {selectedBots.map(bot => (
              <label key={bot.id} className="flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 focus-within:outline-2 focus-within:outline-fg">
                <input type="radio" name={leadChoiceId} value={bot.id} checked={leadId === bot.id}
                  aria-label={bot.name} className="h-4 w-4 shrink-0 accent-fg"
                  onChange={() => dispatch({ type: "lead", id: bot.id })} />
                <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
                {leadId === bot.id && <LeadBadge />}
              </label>
            ))}
          </div>
        </fieldset>
        <p role="status" className="mt-2 text-xs text-muted">{picked.length ? leadId ? `${selectedBots.find(bot => bot.id === leadId)?.name} is the lead.` : "Choose a lead from the selected bots." : "Select members to choose a lead."}</p>
        <label htmlFor={nameId} className="mt-3 block text-sm font-medium">Group name (optional)</label>
        <Input id={nameId} className="mt-1" disabled={busy} value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => { setOpen(false); reset(); }}>Cancel</Button>
          <Button
            disabled={!orderedMembers || busy}
            onClick={async () => {
              if (!orderedMembers || submitting.current) return;
              submitting.current = true;
              setBusy(true);
              try {
                const { id } = await createGroupChat(orderedMembers, name);
                setOpen(false);
                reset();
                onCreated?.();
                router.push(`/c/${id}`);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not create group");
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Start group chat ({picked.length})
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
