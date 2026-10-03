"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Link2, Share } from "lucide-react";
import { createShareLink, revokeShareLinks } from "@/app/(chat)/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";

export function ShareButton({ conversationId }: { conversationId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog onOpenChange={(o) => !o && setUrl(null)}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm hover:bg-hover" aria-label="Share chat">
          <Share className="h-4 w-4" /> <span className="hidden sm:inline">Share</span>
        </button>
      </DialogTrigger>
      <DialogContent
        title="Share link to chat"
        description="Anyone in your organization with the link can view a snapshot of this chat up to now. Messages you send after creating the link won't be shared."
      >
        <div className="flex items-center gap-2 rounded-full border border-border p-1.5 pl-4">
          <span className="flex-1 truncate text-sm text-muted">{url ?? `${typeof window !== "undefined" ? location.origin : ""}/share/…`}</span>
          {url ? (
            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                toast.success("Link copied");
              }}
            >
              Copy link
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const { token } = await createShareLink(conversationId);
                  const u = `${location.origin}/share/${token}`;
                  setUrl(u);
                  await navigator.clipboard.writeText(u).catch(() => {});
                  toast.success("Link created and copied");
                } catch {
                  toast.error("Could not create link");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Link2 className="h-4 w-4" /> Create link
            </Button>
          )}
        </div>
        <button
          className="mt-4 text-sm text-muted underline hover:text-fg"
          onClick={async () => {
            await revokeShareLinks(conversationId);
            setUrl(null);
            toast.success("All links to this chat were revoked");
          }}
        >
          Revoke existing links
        </button>
      </DialogContent>
    </Dialog>
  );
}
