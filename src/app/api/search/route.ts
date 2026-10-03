import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse, requirePrincipal } from "@/lib/session";

/** Full-text search over the user's chat titles and messages. Snippets are HTML-escaped with <mark> highlights. */
export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const q = new URL(req.url).searchParams.get("q")?.trim().slice(0, 200) ?? "";
    if (!q) return Response.json({ results: [] });
    const like = `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`;
    const { rows } = await db.execute<{ conversation_id: string; title: string; snippet: string | null; updated_at: Date }>(sql`
      with query as (select websearch_to_tsquery('english', ${q}) as tsq),
      msg_hits as (
        select m.conversation_id,
               max(ts_rank(m.search_tsv, query.tsq)) as rank,
               (array_agg(
                  ts_headline('english',
                    replace(replace(replace(m.search_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'),
                    query.tsq, 'StartSel=<mark>,StopSel=</mark>,MaxWords=24,MinWords=8')
                  order by ts_rank(m.search_tsv, query.tsq) desc))[1] as snippet
        from messages m, query
        where m.search_tsv @@ query.tsq
        group by m.conversation_id
      )
      select c.id as conversation_id, c.title, h.snippet, c.updated_at
      from conversations c
      left join msg_hits h on h.conversation_id = c.id
      where c.user_id = ${p.user.id}
        and (h.conversation_id is not null or c.title ilike ${like})
      order by (c.title ilike ${like}) desc, coalesce(h.rank, 0) desc, c.updated_at desc
      limit 30
    `);
    return Response.json({
      results: rows.map((r) => ({
        conversationId: r.conversation_id,
        title: r.title,
        snippet: r.snippet,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
