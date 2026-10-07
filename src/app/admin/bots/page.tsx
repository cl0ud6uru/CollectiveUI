import { requireAdminPage } from "@/lib/session";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { BotEnableToggle } from "@/components/admin/row-actions";
import { AdminHeader, Badge, Table, Td } from "@/components/admin/ui";
import { db } from "@/db";
import { aiApps, bots, users } from "@/db/schema";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { BotDeleteButton } from "@/components/bots/bot-delete-button";
import { DefaultCoordinatorBadge } from "@/components/bots/default-coordinator-badge";
import { getSetting } from "@/lib/settings";

export default async function AdminBotsPage() {
  const p = await requireAdminPage();
  const coordinator = await getSetting("coordinator");
  const rows = await db
    .select({
      bot: bots,
      owner: users.name,
      app: aiApps.name,
      tools: sql<string[]>`coalesce((select array_agg(tool_key) from bot_tools t where t.bot_id = ${bots.id}), '{}')`,
      routines: sql<number>`(select count(*)::int from routines r where r.bot_id = ${bots.id})`,
    })
    .from(bots)
    .innerJoin(users, eq(users.id, bots.ownerId))
    .leftJoin(aiApps, eq(aiApps.id, bots.appId))
    .where(sql`${aiApps.providerConfig}->'docker' is null or ${bots.ownerId} = ${p.user.id}`)
    .orderBy(desc(bots.updatedAt));
  return (
    <div>
      <AdminHeader title="Bots" description="Every bot in the organization. Disable a bot to stop chats and routines immediately." />
      <Table head={["Bot", "Owner", "Model / agent backend", "Visibility", "Tools", "Routines", ""]}>
        {rows.map(({ bot, owner, app, tools, routines }) => (
          <tr key={bot.id}>
            <Td>
              <Link href={`/bots/${bot.id}`} className="flex items-center gap-2 font-medium hover:underline">
                <BotAvatar value={bot.avatar} className="h-6 w-6" /> {bot.name}
              </Link>
              {coordinator.enabled && coordinator.defaultBotId === bot.id && <DefaultCoordinatorBadge className="mt-1" />}
              {!bot.enabled && <Badge tone="red">disabled</Badge>}
            </Td>
            <Td>{owner}</Td>
            <Td className="text-xs">{app ?? <span className="text-danger">none</span>}</Td>
            <Td>
              <Badge tone={bot.visibility === "org" ? "green" : bot.visibility === "groups" ? "amber" : "default"}>{bot.visibility}</Badge>
            </Td>
            <Td className="max-w-[260px] text-xs text-muted">{tools.join(", ")}</Td>
            <Td className="tabular-nums">{routines}</Td>
            <Td>
              <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                <Link href={`/bots/${bot.id}/edit`} className="text-xs underline">
                  Edit
                </Link>
                <BotEnableToggle botId={bot.id} enabled={bot.enabled} />
                <BotDeleteButton botId={bot.id} botName={bot.name} iconOnly />
              </div>
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
