import { Sparkles } from "lucide-react";
import { BotAvatar, parseBlob } from "@/components/bots/bot-avatar";
import { cn } from "@/lib/utils";

/** An app's icon in a neutral tile: a bot-style avatar, an admin's emoji, or a line icon by default ("✨" was the old default). */
export function AppIcon({ icon, className }: { icon: string | null | undefined; className?: string }) {
  const value = icon?.trim() === "✨" ? "" : (icon?.trim() ?? "");
  if (parseBlob(value)) return <BotAvatar value={value} className={cn("h-7 w-7", className)} />;
  return (
    <span aria-hidden className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-sm text-muted", className)}>
      {value || <Sparkles className="h-4 w-4" />}
    </span>
  );
}
