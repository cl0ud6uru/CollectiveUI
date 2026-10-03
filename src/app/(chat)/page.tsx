import { getSetting } from "@/lib/settings";
import { defaultCoordinator } from "@/lib/coordinator/store";
import { openSideChat } from "@/lib/chat/side";
import { newId } from "@/lib/ids";
import { NewChat } from "@/components/chat/new-chat";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageFrame } from "@/components/page-frame";
import { HttpError } from "@/lib/authz";
import { openBotHome } from "@/lib/chat/home";
import { resolveTargetOption } from "@/lib/chat/targets";
import { requirePagePrincipal } from "@/lib/session";

export default async function NewChatPage(props: PageProps<"/">) {
  const p = await requirePagePrincipal();
  const sp = await props.searchParams;
  if (typeof sp.bot === "string") {
    let home;
    try {
      home = sp.chat === "side" ? await openSideChat(p, sp.bot, newId()) : await openBotHome(p, sp.bot);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return <PageFrame title="Bot unavailable"><p className="py-6 text-muted">This bot is disabled, deleted, or no longer available to you. Your saved chats remain in history.</p><Link href="/bots" className="underline">Browse bots</Link></PageFrame>;
    }
    redirect(`/c/${home.id}`);
  }
  const personalStart = !!(p.user.prefs?.defaultBotId || p.user.prefs?.defaultAppId);
  if (typeof sp.app !== "string" && sp.chat !== "model" && !personalStart) {
    const config = await getSetting("coordinator");
    const coordinator = await defaultCoordinator(p);
    if (coordinator) {
      if (coordinator.ready) {
        let home;
        try { home = await openBotHome(p, coordinator.bot.id); }
        catch (err) { if (!(err instanceof HttpError)) throw err; }
        if (home) redirect(`/c/${home.id}`);
      }
      return <PageFrame title="Your coordinator">
        <p className="py-6 text-muted">{coordinator.bot.name} needs an available model connection before it can help. Ask an admin to configure it, or choose a specialist or model.</p>
        <div className="flex flex-wrap gap-4"><Link href="/bots" className="underline">Browse bots</Link><Link href="/?chat=model" className="underline">Choose a model</Link>{p.isAdmin && <Link href="/admin/settings" className="underline">Coordinator settings</Link>}</div>
      </PageFrame>;
    }
    if (config.enabled) return <NewChat target={null} skills={[]} unavailableReason="Your default coordinator is unavailable. Choose a bot or model to start a chat." />;
  }
  const { target, skills, unavailableReason } = await resolveTargetOption(p, {
    appId: typeof sp.app === "string" ? sp.app : undefined,
    botId: typeof sp.bot === "string" ? sp.bot : undefined,
    modelsOnly: sp.chat === "model",
  });
  return <NewChat target={target} skills={skills} unavailableReason={unavailableReason} />;
}
