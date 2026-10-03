"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { deleteBot } from "@/app/(chat)/bots/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The editor and admin list share one confirmation and the existing guarded server action. */
export function BotDeleteButton({ botId, botName, iconOnly = false, redirectTo, disabled, className }: {
  botId: string;
  botName: string;
  iconOnly?: boolean;
  redirectTo?: string;
  disabled?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submitting = useRef(false);
  const label = `${pending ? "Deleting" : "Delete"} bot “${botName}”`;

  return (
    <Button
      variant="ghost"
      size={iconOnly ? "icon" : "md"}
      className={cn("text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger", iconOnly && "h-11 w-11 sm:h-9 sm:w-9", className)}
      aria-label={label}
      aria-busy={pending}
      title={label}
      disabled={disabled || pending}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (disabled || pending || submitting.current) return;
        // Lock synchronously, before React renders the pending state.
        submitting.current = true;
        if (!window.confirm(
          `Permanently delete bot “${botName}”? Its conversations' bot link, routines, skills and memories are removed. This cannot be undone.\n\nIf you may need the work later, hide it from the sidebar instead.`,
        )) {
          submitting.current = false;
          return;
        }
        start(async () => {
          try {
            await deleteBot(botId);
            toast.success(`Bot “${botName}” deleted`);
            if (redirectTo) router.push(redirectTo);
            else router.refresh();
          } catch (err) {
            // Production Server Action errors may hide their message behind a digest.
            toast.error(err instanceof Error && !("digest" in err) ? err.message :
              `Could not delete bot “${botName}”. It may be protected or your access may have changed. Try again or disable it instead.`);
          } finally {
            submitting.current = false;
          }
        });
      }}
    >
      {pending ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Trash2 aria-hidden="true" className="h-4 w-4" />}
      {!iconOnly && (pending ? "Deleting…" : "Delete")}
    </Button>
  );
}
