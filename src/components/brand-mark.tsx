"use client";

import { useState } from "react";
import { BotAvatar, parseBlob } from "@/components/bots/bot-avatar";
import { cn } from "@/lib/utils";

/** The original default icon. Treated as "no choice made", so older saved branding gets the portal mark too. */
const LEGACY_DEFAULT_ICON = "✨";

/** The portal's own mark: an ink blob with two eyes, in the same family as bot avatars. Follows light/dark. */
export function PortalMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <circle cx="50" cy="50" r="44" fill="var(--fg)" />
      <rect x="37" y="36" width="9" height="20" rx="4.5" fill="var(--bg)" transform="rotate(-14 41.5 46)" />
      <rect x="55" y="36" width="9" height="20" rx="4.5" fill="var(--bg)" transform="rotate(-14 59.5 46)" />
    </svg>
  );
}

/** Decorative beside the portal name. A missing logo falls back to the chosen icon, then the portal mark. */
export function BrandMark({ logoUrl, logoEmoji, className }: { logoUrl?: string | null; logoEmoji: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const icon = logoEmoji.trim() === LEGACY_DEFAULT_ICON ? "" : logoEmoji.trim();
  return (
    <span aria-hidden="true" className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl text-2xl", className)}>
      {logoUrl && failed !== logoUrl ? (
        // The public route serves only our sanitized PNG; native img avoids an image optimizer cache after removal.
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={(img) => { if (img?.complete && !img.naturalWidth) setFailed(logoUrl); }} src={logoUrl} alt="" className="h-full w-full object-contain" onError={() => setFailed(logoUrl)} />
      ) : parseBlob(icon) ? (
        <BotAvatar value={icon} className="h-full w-full" />
      ) : icon ? (
        icon
      ) : (
        <PortalMark className="h-full w-full" />
      )}
    </span>
  );
}
