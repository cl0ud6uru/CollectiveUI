/** Resolve @mentions in group-chat text to member ids (longest-name match, case-insensitive; @everyone = all). */
export function resolveMentions(text: string, members: { id: string; name: string }[]): string[] {
  const out: string[] = [];
  const add = (id: string) => !out.includes(id) && out.push(id);
  const sorted = [...members].sort((a, b) => b.name.length - a.name.length);
  const lower = text.toLowerCase();
  for (let i = lower.indexOf("@"); i !== -1; i = lower.indexOf("@", i + 1)) {
    if (i > 0 && /[\w.]/.test(lower[i - 1])) continue; // e-mail addresses
    const rest = lower.slice(i + 1);
    if (/^(everyone|all|channel)\b/.test(rest)) {
      members.forEach((m) => add(m.id));
      continue;
    }
    for (const m of sorted) {
      const variants = [m.name.toLowerCase(), m.name.toLowerCase().replace(/\s+/g, "")];
      const hit = variants.find((v) => rest.startsWith(v) && !/[a-z0-9]/.test(rest.charAt(v.length)));
      if (hit) {
        add(m.id);
        break;
      }
    }
  }
  return out;
}
