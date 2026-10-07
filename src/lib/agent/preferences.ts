import type { UserPrefs } from "@/db/schema";

/** Sidebar navigation can change during another bot's turn without changing its guidance or access. */
export function agentPreferences(prefs: UserPrefs | undefined) {
  const result = { ...prefs };
  delete result.botOrder;
  delete result.botLastSentAt;
  return result;
}
