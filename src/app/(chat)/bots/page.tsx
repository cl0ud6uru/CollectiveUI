import Link from "next/link";
import { Plus } from "lucide-react";
import { PageFrame } from "@/components/page-frame";
import { BotGrid } from "@/components/bots/bot-grid";
import { listAccessibleBots } from "@/lib/authz";
import { requirePagePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";

export default async function BotsPage() {
  const p = await requirePagePrincipal();
  const bots = await listAccessibleBots(p);
  const t = await getSetting("tools");
  const canCreate = t.botCreation === "everyone" || (t.botCreation === "groups" ? p.canCreateBots : p.isAdmin);
  const mine = bots.filter((b) => b.ownerId === p.user.id);
  const others = bots.filter((b) => b.ownerId !== p.user.id);
  const toCard = (b: (typeof bots)[number]) => ({ id: b.id, name: b.name, avatar: b.avatar, label: b.label, description: b.description, visibility: b.visibility });

  return (
    <PageFrame
      wide
      title="Bots"
      description="AI teammates with a job, tools, memory and skills. They can work on a schedule and ask before doing anything sensitive."
      actions={
        canCreate && (
          <Link href="/bots/new" className="flex items-center gap-1.5 rounded-full bg-fg px-4 py-2 text-sm font-medium text-bg hover:opacity-85">
            <Plus className="h-4 w-4" /> Create
          </Link>
        )
      }
    >
      <BotGrid mine={mine.map(toCard)} others={others.map(toCard)} />
    </PageFrame>
  );
}
