/**
 * Pure rules for "Sign in with ChatGPT": reading the sign-in claims, and deciding who may connect which account.
 * No I/O, so it is unit-tested directly and shared by the connect flow, token refresh and model resolution.
 */
import type { ChatGPTSettings } from "@/lib/settings";

type PrincipalLike = { user: { upn: string }; groupIds: string[]; isAdmin: boolean };

/**
 * Whether this person may connect and use a ChatGPT plan. Admins may always connect while the feature is on (they
 * need a connection to list models); everyone else needs to be allowed by the admin settings.
 */
export function userMayUseChatGPT(p: PrincipalLike, s: ChatGPTSettings): boolean {
  if (!s.enabled) return false;
  if (p.isAdmin || s.access === "everyone") return true;
  const upn = p.user.upn.toLowerCase();
  return s.allowedUpns.some((u) => u.trim().toLowerCase() === upn) || p.groupIds.some((g) => s.allowedGroupIds.includes(g));
}

export type ChatGPTClaims = {
  accountId: string;
  planType: string | null;
  /** chatgpt_user_id: the person, as opposed to the workspace. */
  userId: string | null;
  email: string | null;
  isFedramp: boolean;
  residency: string | null;
  /** Access token expiry (JWT exp). */
  expiresAt: Date | null;
};

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";

/** Decodes a JWT payload without verifying it: the tokens come straight from OpenAI's token endpoint over TLS. */
export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Account facts from a token response. The id token is preferred; the access token carries the same auth claims
 * (pi reads the account id from it), so it is the fallback. `fallbackIdToken` (an earlier id token, for refreshes that
 * return none) only fills in what neither fresh token says, e.g. FedRAMP and residency, without freezing the plan.
 * Returns null when there's no account id.
 */
export function readChatGPTClaims(tokens: { idToken?: string; accessToken: string; fallbackIdToken?: string }): ChatGPTClaims | null {
  const id = decodeJwtPayload(tokens.idToken);
  const access = decodeJwtPayload(tokens.accessToken);
  const fallback = decodeJwtPayload(tokens.fallbackIdToken);
  const auth = (p: Record<string, unknown> | null) => ((p?.[AUTH_CLAIM] ?? {}) as Record<string, unknown>);
  const a = { ...auth(fallback), ...auth(access), ...auth(id) };
  const accountId = str(a.chatgpt_account_id);
  if (!accountId) return null;
  const residency = str(a.chatgpt_data_residency) ?? str(a.chatgpt_compute_residency);
  const profile = { ...((fallback?.[PROFILE_CLAIM] ?? {}) as object), ...((id?.[PROFILE_CLAIM] ?? {}) as object) } as Record<string, unknown>;
  const exp = typeof access?.exp === "number" ? access.exp : null;
  return {
    accountId,
    planType: str(a.chatgpt_plan_type)?.toLowerCase() ?? null,
    userId: str(a.chatgpt_user_id) ?? str(a.user_id),
    email: str(id?.email) ?? str(fallback?.email) ?? str(profile.email),
    isFedramp: a.chatgpt_account_is_fedramp === true,
    residency: residency && residency !== "no_constraint" ? residency : null,
    expiresAt: exp ? new Date(exp * 1000) : null,
  };
}

/** Business, Enterprise, Edu and Team workspaces (Codex's is_workspace_account), as opposed to personal plans. */
export function isWorkspacePlan(plan: string | null | undefined): boolean {
  if (!plan) return false;
  const p = plan.toLowerCase();
  return (
    ["team", "business", "enterprise", "hc", "edu", "education", "edu_plus", "edu_pro"].includes(p) ||
    p.startsWith("self_serve_business_") ||
    p.startsWith("enterprise_cbp_")
  );
}

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  hc: "Enterprise",
  edu: "Edu",
  education: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

export function planLabel(plan: string | null | undefined): string {
  if (!plan) return "Unknown plan";
  const p = plan.toLowerCase();
  if (PLAN_LABELS[p]) return PLAN_LABELS[p];
  if (p.startsWith("self_serve_business_")) return "Business";
  if (p.startsWith("enterprise_cbp_")) return "Enterprise";
  return plan;
}

/**
 * Why this ChatGPT account may not be used under the current settings, or null when it may. Workspace plans must be
 * in the allowed-workspace list (when there is one); personal plans need allowPersonalPlans. An unknown plan counts
 * as personal.
 */
export function accountRejection(claims: { accountId: string; planType: string | null }, s: ChatGPTSettings): string | null {
  if (isWorkspacePlan(claims.planType)) {
    const allowed = s.allowedWorkspaceIds.map((w) => w.trim()).filter(Boolean);
    if (allowed.length && !allowed.includes(claims.accountId)) {
      return "This ChatGPT workspace isn't one your organization allows. Sign in with your company workspace.";
    }
    return null;
  }
  if (!s.allowPersonalPlans) {
    return `Personal ChatGPT plans (${planLabel(claims.planType)}) aren't allowed here. Sign in with your company's ChatGPT workspace.`;
  }
  return null;
}
