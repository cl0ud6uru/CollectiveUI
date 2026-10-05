import { ChatShell } from "@/components/chat/chat-shell";
import { ShellProvider } from "@/components/chat/shell-context";
import { readAccessiblePets } from "@/lib/pets/store";
import { PetProvider } from "@/components/pets/pet-context";
import { requirePagePrincipal } from "@/lib/session";
import { loadShell } from "@/lib/chat/shell";

export default async function ChatLayout({ children }: LayoutProps<"/">) {
  const p = await requirePagePrincipal();
  const shell = await loadShell(p);
  const initialPets = await readAccessiblePets(p, shell.botRows);

  return (
    <ShellProvider
      key={p.user.id}
      user={shell.user}
      branding={shell.branding}
      conversations={shell.conversations}
      folders={shell.folders}
      apps={shell.apps}
      bots={shell.bots}
      inboxUnread={shell.inboxUnread}
    >
      <PetProvider key={p.user.id} accountId={p.user.id} initialPets={initialPets}><ChatShell>{children}</ChatShell></PetProvider>
    </ShellProvider>
  );
}
