"use client";

import { PetArt } from "@/components/pets/pet-art";
import { useOptionalPets, usePetEnvironment } from "@/components/pets/pet-context";
import { draftPetPreview, petDisplayName } from "@/lib/pets/preview";
import type { BotPetDefault, CatalogPet } from "@/lib/pets/shared";
import { AvatarPicker } from "./avatar-picker";
import { BaseBotAvatar } from "./blob-avatar";

/**
 * The large avatar at the top of the bot editor follows the selected appearance before anything is saved. A new bot
 * previews its unsaved pet choice; an existing bot shows the pet you see for it, which the Pet avatar dialog saves
 * and updates in place. The original icon stays editable and is restored when "Original bot icon" is chosen.
 */
export function BuilderAvatar({ botId, avatar, onAvatarChange, initialPet, catalog }: {
  botId?: string;
  avatar: string | null | undefined;
  onAvatarChange: (value: string) => void;
  initialPet?: BotPetDefault;
  catalog: CatalogPet[];
}) {
  const pets = useOptionalPets();
  const { visible } = usePetEnvironment();
  const saved = botId ? pets?.pets[botId] : undefined;
  const pet = botId ? (saved?.enabled ? saved : null) : draftPetPreview(initialPet, catalog);
  if (!pet) return <AvatarPicker value={avatar} onChange={onAvatarChange} />;
  const name = petDisplayName(pet);
  return (
    <div className="flex flex-col items-center gap-1.5" data-testid="builder-avatar-preview" data-pet-appearance={pet.appearance}>
      <span role="img" aria-label={`Avatar preview: ${name}`} className="flex h-[88px] w-[88px] items-center justify-center">
        <PetArt pet={pet} state="idle" size={74} still={!visible} fallback={<BaseBotAvatar value={avatar} size={80} className="h-20 w-20" />} />
      </span>
      <p className="max-w-xs text-center text-xs text-muted">
        {botId
          ? <>Showing {name}, as you see this bot. Change it under Pet avatar.</>
          : <>Showing {name}. Choose &ldquo;Original bot icon&rdquo; below to use and edit the icon instead.</>}
      </p>
      {botId && (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <span>Original icon</span>
          <AvatarPicker value={avatar} onChange={onAvatarChange} className="h-6 w-6" size={24} />
        </div>
      )}
    </div>
  );
}
