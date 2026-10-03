"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { createGroupChat } from "@/app/(chat)/bots/actions";
import type { TargetOption } from "@/components/chat/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BotAvatar } from "@/components/bots/bot-avatar";

/** Pick 2–6 bots for a group chat. Selection order matters: the first bot leads. */
export function NewGroupDialog({ bots, trigger, onCreated }: { bots: TargetOption[]; trigger: React.ReactNode; onCreated?: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setPicked([]);
          setName("");
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent title="New group chat" description="Pick two to six bots that share an outcome. The first one you pick leads and answers messages that don't @mention anyone.">
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {bots.map((b) => {
            const idx = picked.indexOf(b.id);
            return (
              <button
                key={b.id}
                onClick={() => setPicked((p) => (idx >= 0 ? p.filter((x) => x !== b.id) : p.length < 6 ? [...p, b.id] : p))}
                className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left hover:bg-hover", idx >= 0 && "bg-hover")}
              >
                <BotAvatar botId={b.id} value={b.icon} size={28} className="h-7 w-7" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{b.name}</span>
                  {b.label && <span className="block truncate text-xs text-muted">{b.label}</span>}
                </span>
                {idx === 0 && <span className="text-xs text-subtle">lead</span>}
                <span className={cn("flex h-5 w-5 items-center justify-center rounded-full border", idx >= 0 ? "border-fg bg-fg text-bg" : "border-border")}>
                  {idx >= 0 && <Check className="h-3 w-3" />}
                </span>
              </button>
            );
          })}
          {!bots.length && <p className="text-sm text-muted">You don&apos;t have any bots yet.</p>}
        </div>
        <Input className="mt-3" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name (optional)" />
        <div className="mt-4 flex justify-end">
          <Button
            disabled={picked.length < 2 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const { id } = await createGroupChat(picked, name);
                setOpen(false);
                onCreated?.();
                router.push(`/c/${id}`);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Could not create group");
              } finally {
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
