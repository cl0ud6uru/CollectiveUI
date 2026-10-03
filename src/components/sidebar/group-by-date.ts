import type { ConversationSummary } from "@/components/chat/types";

export function groupByDate(convs: ConversationSummary[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const groups: { label: string; items: ConversationSummary[] }[] = [];
  const push = (label: string, c: ConversationSummary) => {
    let g = groups.find((x) => x.label === label);
    if (!g) groups.push((g = { label, items: [] }));
    g.items.push(c);
  };
  for (const c of convs) {
    const t = new Date(c.updatedAt).getTime();
    if (t >= startOfToday) push("Today", c);
    else if (t >= startOfToday - day) push("Yesterday", c);
    else if (t >= startOfToday - 7 * day) push("Previous 7 days", c);
    else if (t >= startOfToday - 30 * day) push("Previous 30 days", c);
    else {
      const d = new Date(t);
      push(d.getFullYear() === now.getFullYear() ? d.toLocaleString("en", { month: "long" }) : String(d.getFullYear()), c);
    }
  }
  return groups;
}

/** Short roster timestamp like Grok Bot: "9:41 AM" today, "Yesterday", a weekday this week, else "Mar 3". */
export function shortTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  const day = 86_400_000;
  if (t >= startOfToday) return d.toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
  if (t >= startOfToday - day) return "Yesterday";
  if (t >= startOfToday - 6 * day) return d.toLocaleDateString("en", { weekday: "long" });
  return d.toLocaleDateString("en", { month: "short", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
