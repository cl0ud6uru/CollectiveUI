"use client";

import { useRouter } from "next/navigation";
import { markInboxRead } from "@/app/(chat)/actions";
import { Button } from "@/components/ui/button";

export function InboxActions({ id, unread }: { id: string; unread: boolean }) {
  const router = useRouter();
  if (!unread) return null;
  return (
    <button
      className="text-muted hover:text-fg"
      onClick={async () => {
        await markInboxRead(id);
        router.refresh();
      }}
    >
      Mark as read
    </button>
  );
}

export function MarkAllRead() {
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await markInboxRead();
        router.refresh();
      }}
    >
      Mark all read
    </Button>
  );
}
