import type { Skill } from "@/db/schema";

/** Resolve only the current authorized catalog; authored canonical slugs take precedence. */
export function findSkill(available: readonly Skill[], slug: string) {
  return available.find(skill => skill.slug === slug) ?? available.find(skill => skill.aliases?.includes(slug));
}

export function slashInvokedSkill(available: readonly Skill[], text: string) {
  const slash = /^\/([a-zA-Z0-9_-]+)(?![a-zA-Z0-9_-])/.exec(text.trim());
  return slash ? findSkill(available, slash[1]) : undefined;
}
