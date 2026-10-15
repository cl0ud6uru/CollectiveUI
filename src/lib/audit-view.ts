const AGENT_NAMES: Record<string, string> = { architect: "The Architect" };

/** "<person> via <agent>" when an audit entry was made through a bot (details.via), otherwise the person's name. */
export function auditActorLabel(actor: string | null, details: unknown): string {
  const person = actor ?? "(deleted user)";
  const via = details && typeof details === "object" && "via" in details ? (details as { via: unknown }).via : null;
  const agent = via && typeof via === "object" && "agent" in via ? (via as { agent: unknown }).agent : null;
  return typeof agent === "string" && AGENT_NAMES[agent] ? `${person} via ${AGENT_NAMES[agent]}` : person;
}
