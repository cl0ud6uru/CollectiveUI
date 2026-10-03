"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2 } from "lucide-react";
import { duplicateBot } from "@/app/(chat)/bots/actions";
import { cn } from "@/lib/utils";

export function UseAsTemplateButton({ botId, className }: { botId: string; className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { id, pausedRoutines } = await duplicateBot(botId);
          toast.success(pausedRoutines ? `Duplicated — ${pausedRoutines} routine(s) copied paused` : "Duplicated — it's private until you share it");
          router.push(`/bots/${id}/edit`);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not copy bot");
          setBusy(false);
        }
      }}
      className={cn("flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium hover:bg-hover disabled:opacity-50", className)}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />} Duplicate
    </button>
  );
}
