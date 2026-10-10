"use client";

import Image from "next/image";
import { useState } from "react";
import { useOptionalPets } from "@/components/pets/pet-context";
import { petPortrait } from "@/lib/pets/portraits";

/** Still, decorative artwork below the bot's controls. A missing portrait leaves no empty frame. */
export function BotPortrait({ botId }: { botId: string }) {
  const context = useOptionalPets();
  const portrait = petPortrait(context?.pets[botId]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!portrait || failedSrc === portrait.src) return null;
  return (
    <div data-bot-portrait className="mt-6 flex shrink-0 justify-center" aria-hidden="true">
      <Image
        src={portrait.src}
        width={portrait.width}
        height={portrait.height}
        alt=""
        unoptimized
        draggable={false}
        onError={() => setFailedSrc(portrait.src)}
        className="h-[clamp(180px,38dvh,420px)] w-full object-contain"
      />
    </div>
  );
}
