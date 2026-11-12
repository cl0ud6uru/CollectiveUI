"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * Fallback for a route segment that threw while rendering. The surrounding layout (sidebar, navigation) stays
 * mounted, so one broken page or conversation doesn't take the whole portal down.
 */
export function RouteError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  // Server errors arrive with a generic message; the digest matches the server log entry.
  const digest = typeof error === "object" && error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <div role="alert" className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 text-center">
      <h2 className="text-lg font-semibold">This page couldn&apos;t be shown</h2>
      <p className="max-w-md text-sm text-muted">Something went wrong while loading it. Your chats and files are not affected.</p>
      {digest ? <p className="text-xs text-muted">Reference: {digest}</p> : null}
      <div className="mt-2 flex gap-2">
        <Button onClick={() => retry()}>Try again</Button>
        {/* A full page load on purpose: client state may be what broke, so don't carry it over. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="inline-flex h-10 items-center rounded-full border border-border px-4 text-sm font-medium hover:bg-hover">Go to start</a>
      </div>
    </div>
  );
}
