"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { addBotFromTemplate } from "@/app/(chat)/bots/actions";

export function AddTemplateButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const { id } = await addBotFromTemplate(token);
          toast.success("Added to your bots");
          router.push(`/bots/${id}/edit`);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not add bot");
          setBusy(false);
        }
      }}
      className="mt-5 flex items-center gap-2 rounded-full bg-fg px-5 py-2.5 text-sm font-medium text-bg hover:opacity-85 disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add to my bots
    </button>
  );
}
