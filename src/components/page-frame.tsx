"use client";

import { Menu as MenuIcon } from "lucide-react";
import { useShell } from "@/components/chat/shell-context";
import { cn } from "@/lib/utils";

/**
 * Every non-chat page: a slim bar (mobile menu, page actions), then one left-aligned title with an optional line of
 * description at the top of the content column, the way ChatGPT desktop lays out Library and Plugins.
 */
export function PageFrame({
  title,
  description,
  actions,
  children,
  wide,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const { setMobileOpen } = useShell();
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-3">
        <button onClick={() => setMobileOpen(true)} className="rounded-lg p-2 text-muted hover:bg-hover md:hidden" aria-label="Open sidebar">
          <MenuIcon className="h-5 w-5" />
        </button>
        <div className="flex-1" />
        {actions}
      </header>
      <div data-page-scroll className="flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full px-4 pb-16 pt-2 md:px-6", wide ? "max-w-6xl" : "max-w-3xl")}>
          {title && (
            <div className="mb-6">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
              {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
