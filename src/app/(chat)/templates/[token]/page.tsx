import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Clock, Sparkles, Webhook, Wrench } from "lucide-react";
import { AddTemplateButton } from "@/components/bots/add-template-button";
import { BotAvatar } from "@/components/bots/bot-avatar";
import { PageFrame } from "@/components/page-frame";
import { db } from "@/db";
import { botTemplates, users } from "@/db/schema";
import { BUILTIN_TOOLS } from "@/lib/agent/types";
import { cronToText } from "@/lib/cron-text";
import { requirePagePrincipal } from "@/lib/session";

/** Template preview (sign-in required, so links stay inside the organization). */
export default async function TemplatePage(props: PageProps<"/templates/[token]">) {
  await requirePagePrincipal();
  const { token } = await props.params;
  const [t] = await db
    .select({ t: botTemplates, author: users.name })
    .from(botTemplates)
    .innerJoin(users, eq(users.id, botTemplates.createdBy))
    .where(and(eq(botTemplates.id, token), isNull(botTemplates.revokedAt)));
  if (!t) notFound();
  const s = t.t.snapshot;
  const toolLabel = (k: string) => BUILTIN_TOOLS.find((b) => b.key === k)?.label ?? (k.startsWith("mcp:") ? "Company connector (MCP)" : k);

  return (
    <PageFrame>
      <div className="flex flex-col items-center py-8 text-center">
        <BotAvatar value={s.avatar} size={80} className="mb-4 h-20 w-20" />
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">Bot template</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{s.name}</h1>
        {s.label && <span className="mt-1 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted">{s.label}</span>}
        <p className="mt-1 text-sm text-subtle">Shared by {t.author}</p>
        {s.description && <p className="mt-3 max-w-xl text-muted">{s.description}</p>}
        <AddTemplateButton token={token} />
        <p className="mt-2 max-w-md text-xs text-subtle">Adds a private copy to your bots. Routines arrive paused. Bots are created by colleagues — review the instructions before relying on them.</p>
      </div>
      <div className="space-y-6">
        {s.instructions && (
          <section>
            <h2 className="mb-2 text-sm font-medium">Instructions</h2>
            <p className="whitespace-pre-wrap rounded-xl border border-border p-3 text-sm text-muted">{s.instructions}</p>
          </section>
        )}
        {s.boundaries && (
          <section>
            <h2 className="mb-2 text-sm font-medium">Boundaries</h2>
            <p className="whitespace-pre-wrap rounded-xl border border-border p-3 text-sm text-muted">{s.boundaries}</p>
          </section>
        )}
        {s.tools.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium">Tools</h2>
            <div className="flex flex-wrap gap-2">
              {s.tools.map((tool) => (
                <span key={tool.key} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm">
                  <Wrench className="h-3.5 w-3.5 text-muted" /> {toolLabel(tool.key)}
                  {tool.approval === "ask" && <span className="text-xs text-subtle">· asks first</span>}
                </span>
              ))}
            </div>
          </section>
        )}
        {s.skills.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium">Skills</h2>
            <div className="space-y-2">
              {s.skills.map((k) => (
                <div key={k.slug} className="flex gap-3 rounded-xl border border-border p-3 text-sm">
                  <Sparkles className="mt-0.5 h-4 w-4 text-accent" />
                  <div>
                    <div className="font-medium">
                      {k.name} <span className="font-normal text-subtle">/{k.slug}</span>
                    </div>
                    <div className="text-muted">{k.description}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
        {s.routines.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-medium">Routines</h2>
            <div className="space-y-2">
              {s.routines.map((r, i) => (
                <div key={i} className="flex gap-3 rounded-xl border border-border p-3 text-sm">
                  {r.triggerType === "cron" ? <Clock className="mt-0.5 h-4 w-4 text-muted" /> : <Webhook className="mt-0.5 h-4 w-4 text-muted" />}
                  <div>
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted">{r.triggerType === "cron" ? `${cronToText(r.cron)} (${r.timezone})` : "Webhook"}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </PageFrame>
  );
}
