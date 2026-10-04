import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";

/**
 * Usage reporting. Token counts come from two sources:
 *  - usage_events: one row per model call (chat steps, delegates, titles, memory, drafts, embeddings), written
 *    since the provider registry landed;
 *  - messages written before that (billing_source IS NULL), which only carry per-reply totals.
 * Reply counts always come from assistant messages. Titles, memory extraction, drafts and embeddings are shown
 * as "Background"; group conversations as "Group chats". billing_source says who paid: "org" (company credentials)
 * or "chatgpt_plan" (the person's own ChatGPT plan, no cost to the company).
 */

const BACKGROUND = sql`('title', 'memory', 'draft', 'embedding')`;

/** One row per token-bearing record (ledger event or legacy reply) plus reply counts, since `since`. */
function tokenRows(since: SQL) {
  return sql`
    select e.created_at as at, e.user_id as user_id,
           case when c.is_group then 'Group chats'
                when e.purpose in ${BACKGROUND} then 'Background'
                else coalesce(ca.name, cb.name, a.name, b.name, 'Unknown') end as target,
           e.purpose as purpose, e.billing_source as billing_source, 0 as replies,
           coalesce(e.input_tokens, 0)::bigint as input_tokens, coalesce(e.output_tokens, 0)::bigint as output_tokens,
           coalesce(e.cache_read_tokens, 0)::bigint as cache_read_tokens, coalesce(e.cache_write_tokens, 0)::bigint as cache_write_tokens,
           coalesce(e.reasoning_tokens, 0)::bigint as reasoning_tokens,
           coalesce(e.hosted_search_calls, 0)::bigint as hosted_search_calls,
           coalesce(e.search_tool_cost_estimate_micros, 0)::bigint as search_tool_cost_estimate_micros
    from usage_events e
    left join conversations c on c.id = e.conversation_id
    left join ai_apps ca on ca.id = c.app_id
    left join bots cb on cb.id = c.bot_id
    left join ai_apps a on a.id = e.app_id
    left join bots b on b.id = e.bot_id
    where e.created_at > ${since}
    union all
    select m.created_at, c.user_id,
           case when c.is_group then 'Group chats' else coalesce(a.name, b.name, 'Unknown') end,
           'chat', coalesce(m.billing_source, 'org'), 1,
           case when m.billing_source is null then coalesce(m.input_tokens, 0) else 0 end::bigint,
           case when m.billing_source is null then coalesce(m.output_tokens, 0) else 0 end::bigint,
           0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint
    from messages m
    join conversations c on c.id = m.conversation_id
    left join ai_apps a on a.id = c.app_id
    left join bots b on b.id = c.bot_id
    where m.role = 'assistant' and m.created_at > ${since}`;
}

export async function usageSummary(days = 30) {
  const since = sql`now() - make_interval(days => ${days})`;
  const [totals] = (
    await db.execute<{
      users: number;
      active_users: number;
      conversations: number;
      messages: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      thumbs_up: number;
      thumbs_down: number;
      bots: number;
      tool_calls: number;
      hosted_search_calls: number;
      search_tool_cost_estimate_micros: number;
    }>(sql`
      with t as (${tokenRows(since)})
      select
        (select count(*)::int from users) as users,
        (select count(distinct c.user_id)::int from conversations c where c.updated_at > ${since}) as active_users,
        (select count(*)::int from conversations where created_at > ${since}) as conversations,
        (select count(*)::int from messages where created_at > ${since}) as messages,
        (select coalesce(sum(input_tokens), 0)::bigint from t) as input_tokens,
        (select coalesce(sum(output_tokens), 0)::bigint from t) as output_tokens,
        (select coalesce(sum(cache_read_tokens), 0)::bigint from t) as cache_read_tokens,
        (select count(*)::int from messages where feedback = 1 and created_at > ${since}) as thumbs_up,
        (select count(*)::int from messages where feedback = -1 and created_at > ${since}) as thumbs_down,
        (select count(*)::int from bots) as bots,
        (select count(*)::int from tool_calls where created_at > ${since}) as tool_calls,
        (select coalesce(sum(hosted_search_calls), 0)::bigint from t) as hosted_search_calls,
        (select coalesce(sum(search_tool_cost_estimate_micros), 0)::bigint from t) as search_tool_cost_estimate_micros
    `)
  ).rows;

  const daily = (
    await db.execute<{ day: string; messages: number; tokens: number }>(sql`
      with t as (${tokenRows(since)})
      select to_char(d, 'YYYY-MM-DD') as day,
             coalesce(sum(t.replies), 0)::int as messages,
             coalesce(sum(t.input_tokens + t.output_tokens), 0)::bigint as tokens
      from generate_series(date_trunc('day', now()) - make_interval(days => ${days - 1}), date_trunc('day', now()), interval '1 day') d
      left join t on date_trunc('day', t.at) = d
      group by d order by d
    `)
  ).rows;

  const byApp = (
    await db.execute<{ name: string; messages: number; tokens: number }>(sql`
      with t as (${tokenRows(since)})
      select target as name, sum(replies)::int as messages, sum(input_tokens + output_tokens)::bigint as tokens
      from t group by target order by 2 desc, 3 desc limit 15
    `)
  ).rows;

  const byUser = (
    await db.execute<{ name: string; upn: string; messages: number; tokens: number }>(sql`
      with t as (${tokenRows(since)})
      select u.name, u.upn, sum(t.replies)::int as messages, sum(t.input_tokens + t.output_tokens)::bigint as tokens
      from t join users u on u.id = t.user_id
      group by u.id order by 3 desc, 4 desc limit 15
    `)
  ).rows;

  return { totals, daily, byApp, byUser };
}

export const USAGE_EXPORT_COLUMNS = [
  "day",
  "upn",
  "target",
  "replies",
  "input_tokens",
  "output_tokens",
  "purpose",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "billing_source",
  "hosted_search_calls",
  "search_tool_cost_estimate_micros",
] as const;

/** Rows for the admin CSV export (last `days` days), grouped by day, user, target, purpose and who paid. */
export async function usageExportRows(days = 90) {
  const since = sql`now() - make_interval(days => ${days})`;
  const { rows } = await db.execute<Record<(typeof USAGE_EXPORT_COLUMNS)[number], unknown>>(sql`
    with t as (${tokenRows(since)})
    select to_char(date_trunc('day', t.at), 'YYYY-MM-DD') as day, u.upn, t.target, t.purpose, t.billing_source,
           sum(t.replies)::int as replies, sum(t.input_tokens)::bigint as input_tokens, sum(t.output_tokens)::bigint as output_tokens,
           sum(t.cache_read_tokens)::bigint as cache_read_tokens, sum(t.cache_write_tokens)::bigint as cache_write_tokens,
           sum(t.reasoning_tokens)::bigint as reasoning_tokens,
           sum(t.hosted_search_calls)::bigint as hosted_search_calls,
           sum(t.search_tool_cost_estimate_micros)::bigint as search_tool_cost_estimate_micros
    from t left join users u on u.id = t.user_id
    group by 1, 2, 3, 4, 5 order by 1 desc, 2, 3, 4, 5
  `);
  return rows;
}

/**
 * CSV cell. Quotes every value and neutralizes spreadsheet formulas (bot and app names are user-controlled),
 * so a name like "=HYPERLINK(...)" is shown as text.
 */
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: Record<string, unknown>[], cols: readonly string[]): string {
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}
