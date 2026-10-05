import { loadShell } from "@/lib/chat/shell";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { readAccessiblePets } from "@/lib/pets/store";
import { HD_QUERY } from "@/lib/pets/shared";

/** The app's home screen: the same chats, bots, models and inbox count as the web sidebar. */
export async function GET() {
  try {
    const p = await requirePrincipal();
    const { user, branding, conversations, folders, apps, bots, inboxUnread, botRows } = await loadShell(p);
    const identities = await readAccessiblePets(p, botRows);
    // Display-only projection: private imports and pet management privileges stay on the website.
    const pets = Object.fromEntries(Object.entries(identities).map(([botId, pet]) => [botId, {
      enabled: pet.enabled, appearance: pet.appearance, motion: pet.motion,
      spriteVersionNumber: pet.custom?.spriteVersionNumber ?? null,
      spriteUrl: pet.spriteUrl && pet.revision
        ? `/api/mobile/v1/bots/${encodeURIComponent(botId)}/pet/avatar?v=${encodeURIComponent(pet.revision)}`
        : null,
      spriteHdUrl: pet.spriteHdUrl && pet.revision
        ? `/api/mobile/v1/bots/${encodeURIComponent(botId)}/pet/avatar?v=${encodeURIComponent(pet.revision)}&${HD_QUERY}`
        : null,
    }]));
    return Response.json({ user, branding, conversations, folders, apps, bots, inboxUnread, pets }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
