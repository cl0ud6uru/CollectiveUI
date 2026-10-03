"use client";

import { BaseBotAvatar, type BlobState } from "./blob-avatar";
import { DEFAULT_PET, PET_LABELS, type PetState } from "@/lib/pets/shared";
import { PetArt } from "@/components/pets/pet-art";
import { useOptionalPets, usePetEnvironment } from "@/components/pets/pet-context";
import { cn } from "@/lib/utils";

const ACTIVITY_LABELS: Record<PetState, string> = {
  idle: "Idle", working: "Working", approval: "Waiting for your approval", attention: "Needs attention", unavailable: "Unavailable",
};

/** A bot ID opts into the viewer's private identity. Branding, apps and shared previews have no bot ID. */
export function BotAvatar({ botId, value, size = 20, className, state, activity }: {
  botId?: string; value?: string | null; size?: number; className?: string; state?: BlobState;
  /** Explicit evidence for this placement, e.g. a roster or group speaker. Historical speakers stay decorative. */
  activity?: PetState | "decorative";
}) {
  const context = useOptionalPets();
  const { visible } = usePetEnvironment();
  if (!botId) return <BaseBotAvatar value={value} size={size} className={className} state={state} />;
  const pet = context?.pets[botId] ?? DEFAULT_PET;
  const current = context?.activity?.botId === botId ? context.activity : null;
  const shown = activity ?? current?.state ?? "decorative";
  const title = shown === "decorative" ? undefined : activity ? ACTIVITY_LABELS[shown] : PET_LABELS[shown];
  const fallback = <BaseBotAvatar value={value} size={size} className="h-full w-full" state={state} />;
  return <span data-bot-avatar={botId} data-pet-enabled={pet.enabled} data-activity={shown} data-pet-appearance={pet.enabled ? pet.appearance : undefined} className={cn("inline-flex shrink-0 items-center justify-center", className)} style={{ width: size, height: size }} aria-hidden="true" title={pet.enabled ? title : undefined}>
    {pet.enabled ? <PetArt botId={botId} pet={pet} state={shown === "decorative" ? "idle" : shown} size={size * 192 / 208} still={!visible} compact={size <= 32} fallback={fallback} /> : fallback}
  </span>;
}
