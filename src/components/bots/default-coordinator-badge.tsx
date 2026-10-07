import { cn } from "@/lib/utils";

export function DefaultCoordinatorBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full rounded-full bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-400", className)}>
      Default coordinator
    </span>
  );
}
