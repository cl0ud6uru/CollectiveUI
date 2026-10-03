"use client";

import { useRef, useState, type ComponentProps } from "react";
import { useRouter } from "next/navigation";
import { SquarePen } from "lucide-react";
import { toast } from "sonner";
import { createSideChat } from "@/app/(chat)/actions";
import { newId } from "@/lib/ids";

export function StartSideChat({ botId, className = "flex items-center gap-1 rounded-lg p-2 text-sm text-muted hover:bg-hover", compact = false, onCreated, onClick, ...buttonProps }: Omit<ComponentProps<"button">, "children"> & { botId: string; className?: string; compact?: boolean; onCreated?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const attempt = useRef<string | null>(null);
  const pending = useRef(false);
  return <button {...buttonProps} disabled={busy} aria-label="Start side chat" title="Start side chat" className={className} onClick={async (event) => {
    onClick?.(event);
    if (pending.current) return;
    pending.current = true; setBusy(true);
    attempt.current ??= newId();
    try {
      const { id } = await createSideChat(botId, attempt.current);
      onCreated?.(); router.push(`/c/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start side chat");
    } finally { pending.current = false; setBusy(false); }
  }}><SquarePen className="h-4 w-4" /><span className={compact ? "hidden sm:inline" : ""}>Side chat</span></button>;
}
