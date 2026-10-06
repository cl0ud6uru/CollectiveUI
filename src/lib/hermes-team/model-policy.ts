import { z } from "zod";

export const TEAM_MODEL_PURPOSES = ["reply", "learning", "utility", "subagent"] as const;
export type TeamModelPurpose = typeof TEAM_MODEL_PURPOSES[number];
export const TeamModelPolicyModeSchema = z.enum(["admin_provided", "admin_default_personal_allowed", "personal_required"]);
export type TeamModelPolicyMode = z.infer<typeof TeamModelPolicyModeSchema>;

const identifier = z.string().min(1).max(200);
export const TeamModelPolicySchema = z.object({
  mode: TeamModelPolicyModeSchema,
  adminRouteId: identifier.optional(),
  personalRouteId: identifier.optional(),
}).strict();
export type TeamModelPolicy = z.infer<typeof TeamModelPolicySchema>;

/** Separate integrations: native Codex authentication does not verify official ChatGPT plan usage. */
export type TeamModelIntegration = "admin_inference_gateway" | "hermes_native_codex" | "openai_chatgpt_plan_usage";
export type TeamModelBilling = "admin" | "personal";
const integrationSchema = z.enum(["admin_inference_gateway", "hermes_native_codex", "openai_chatgpt_plan_usage"]);
const routeSchema = z.object({
  id: identifier, adapterId: identifier, integration: integrationSchema, model: identifier,
  billing: z.enum(["admin", "personal"]), credentialHandling: z.literal("server_gateway"),
  transportHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidence: z.object({
    id: identifier, hermesRevision: z.string().regex(/^[a-f0-9]{40}$/), adapterId: identifier,
    integration: integrationSchema, model: identifier, purposes: z.array(z.enum(TEAM_MODEL_PURPOSES)),
    verifiedAt: z.number().finite(), expiresAt: z.number().finite(),
  }).strict(),
}).strict();
export type VerifiedTeamModelRoute = {
  id: string;
  adapterId: string;
  integration: TeamModelIntegration;
  model: string;
  billing: TeamModelBilling;
  /** Candidate proof pins server routing/credential revision without storing decrypted secrets. */
  transportHash?: string;
  /** The gateway holds credentials; this contract never accepts a token, key, endpoint or profile path. */
  credentialHandling: "server_gateway";
  evidence: {
    id: string;
    hermesRevision: string;
    adapterId: string;
    integration: TeamModelIntegration;
    model: string;
    purposes: readonly TeamModelPurpose[];
    verifiedAt: number;
    expiresAt: number;
  };
};

/** No live model/auth verification has been performed for Team Bots. Default admission must remain closed. */
export const VERIFIED_TEAM_MODEL_ROUTES: readonly VerifiedTeamModelRoute[] = Object.freeze([]);

export type TeamPersonalModelConnection = {
  id: string;
  userId: string;
  integration: Exclude<TeamModelIntegration, "admin_inference_gateway">;
  status: "active" | "expired" | "revoked";
  expiresAt: number;
};
export type TeamModelAuthority = {
  userId: string;
  botId: string;
  userEnabled: boolean;
  botEnabled: boolean;
  audienceAllowed: boolean;
  policyVersion: number;
  hermesRevision: string;
  policy: TeamModelPolicy;
  personalConnection?: TeamPersonalModelConnection | null;
};
export type TeamModelRequest = {
  botId: string;
  runId: string;
  purpose: TeamModelPurpose;
  /** A personal choice is sticky for this operation: errors never retry using admin billing. */
  choice?: "default" | "personal";
};
export type TeamModelSubjectRequest = TeamModelRequest & { userId: string };
export type TeamModelAttribution = {
  userId: string;
  botId: string;
  runId: string;
  policyVersion: number;
  routeId: string;
  adapterId: string;
  integration: TeamModelIntegration;
  model: string;
  billing: TeamModelBilling;
  purpose: TeamModelPurpose;
  connectionId: string | null;
};
export type TeamModelDenialReason = "access_revoked" | "identity_mismatch" | "invalid_policy" | "invalid_request"
  | "personal_not_allowed" | "route_unverified" | "personal_connection_needed" | "personal_connection_expired";
export type TeamModelAccess =
  | { status: "ready"; attribution: TeamModelAttribution }
  | { status: "connection_needed" | "blocked"; reason: TeamModelDenialReason; message: string };

const deny = (reason: TeamModelDenialReason, message: string, status: "connection_needed" | "blocked" = "blocked"): TeamModelAccess => ({ status, reason, message });
const revision = /^[a-f0-9]{40}$/;

/** Pure admission rules. Authorities and routes must come from the server, never from a browser or native profile. */
export function evaluateTeamModelAccess(
  request: TeamModelSubjectRequest,
  authority: TeamModelAuthority,
  routes: readonly VerifiedTeamModelRoute[] = VERIFIED_TEAM_MODEL_ROUTES,
  now = Date.now(),
): TeamModelAccess {
  if (!request.userId || !request.botId || !request.runId || !TEAM_MODEL_PURPOSES.includes(request.purpose)
    || (request.choice !== undefined && request.choice !== "default" && request.choice !== "personal") || !Number.isFinite(now))
    return deny("invalid_request", "Invalid Team Bot model request.");
  if (authority.userId !== request.userId || authority.botId !== request.botId)
    return deny("identity_mismatch", "Team Bot model identity does not match the current person and bot.");
  if (authority.userEnabled !== true || authority.botEnabled !== true || authority.audienceAllowed !== true)
    return deny("access_revoked", "You no longer have access to this Team Bot.");
  const parsed = TeamModelPolicySchema.safeParse(authority.policy);
  if (!parsed.success || !Number.isSafeInteger(authority.policyVersion) || authority.policyVersion < 1)
    return deny("invalid_policy", "The Team Bot model policy needs attention.");
  const policy = parsed.data;
  if (policy.mode === "admin_provided" && request.choice === "personal")
    return deny("personal_not_allowed", "This bot uses its admin-provided model.");
  const billing: TeamModelBilling = policy.mode === "personal_required" || request.choice === "personal" ? "personal" : "admin";
  const routeId = billing === "personal" ? policy.personalRouteId : policy.adminRouteId;
  const matches = routes.filter((r) => r.id === routeId);
  const parsedRoute = matches.length === 1 ? routeSchema.safeParse(matches[0]) : null;
  const route = parsedRoute?.success ? parsedRoute.data : undefined;
  const evidence = route?.evidence;
  // All categories must be verified before any native run starts, because Hermes can launch helpers itself.
  if (!route || !evidence || !revision.test(authority.hermesRevision) || route.billing !== billing
    || route.credentialHandling !== "server_gateway" || !route.adapterId || !route.model || !evidence.id
    || evidence.hermesRevision !== authority.hermesRevision || evidence.adapterId !== route.adapterId
    || evidence.integration !== route.integration || evidence.model !== route.model
    || (billing === "admin") !== (route.integration === "admin_inference_gateway")
    || !Number.isFinite(evidence.verifiedAt) || evidence.verifiedAt > now
    || !Number.isFinite(evidence.expiresAt) || evidence.expiresAt <= now
    || !TEAM_MODEL_PURPOSES.every((purpose) => evidence.purposes.includes(purpose)))
    return deny("route_unverified", "This bot's model route has not been verified. Model connection is needed.", "connection_needed");
  let connectionId: string | null = null;
  if (billing === "personal") {
    const connection = authority.personalConnection;
    if (!connection || !connection.id || connection.userId !== request.userId || connection.integration !== route.integration || connection.status === "revoked")
      return deny("personal_connection_needed", "Connect your own ChatGPT account to use this bot.", "connection_needed");
    if (connection.status !== "active" || !Number.isFinite(connection.expiresAt) || connection.expiresAt <= now)
      return deny("personal_connection_expired", "Reconnect your ChatGPT account. This bot's work is paused.", "connection_needed");
    connectionId = connection.id;
  }
  return { status: "ready", attribution: {
    userId: request.userId, botId: request.botId, runId: request.runId, policyVersion: authority.policyVersion,
    routeId: route.id, adapterId: route.adapterId, integration: route.integration, model: route.model, billing, purpose: request.purpose, connectionId,
  } };
}

export class TeamModelPolicyError extends Error {
  constructor(public readonly decision: Exclude<TeamModelAccess, { status: "ready" }>) {
    super(decision.message);
    this.name = "TeamModelPolicyError";
  }
}

export type TeamModelGatewayDependencies<Input, Output> = {
  /** Resolve the current human from the authenticated request/session, including queued work. */
  currentUserId(): Promise<string>;
  loadAuthority(userId: string, botId: string): Promise<TeamModelAuthority>;
  routes: readonly VerifiedTeamModelRoute[];
  now(): number;
  /** Must atomically reserve configured limits with current authorization, attribution and idempotent run receipts. */
  reserveUsage(attribution: TeamModelAttribution): Promise<{ id: string; attribution: TeamModelAttribution }>;
  releaseUsage(receiptId: string): Promise<void>;
  /**
   * A supported server gateway resolves credentials and dispatches the exact route/model without native env fallback.
   * It must atomically revalidate current authority, own idempotent execution and settle reserved usage on success/failure.
   * Once dispatch starts, a failed response is not proof that the provider performed no billable work.
   */
  dispatch(input: Input, attribution: TeamModelAttribution, usageReceiptId: string): Promise<Output>;
};

function requireReady(decision: TeamModelAccess): TeamModelAttribution {
  if (decision.status !== "ready") throw new TeamModelPolicyError(decision);
  return decision.attribution;
}

/** An injectable boundary for a future supported gateway. Nothing in this module installs a live adapter. */
export function createTeamModelGateway<Input, Output>(dependencies: TeamModelGatewayDependencies<Input, Output>) {
  return {
    async execute(request: TeamModelRequest, input: Input): Promise<Output> {
      const userId = await dependencies.currentUserId();
      const subject = { ...request, userId };
      const authority = await dependencies.loadAuthority(userId, request.botId);
      const attribution = requireReady(evaluateTeamModelAccess(subject, authority, dependencies.routes, dependencies.now()));
      const receipt = await dependencies.reserveUsage(attribution);
      let dispatchStarted = false;
      try {
        // Queuing and limit reservation may take time. Recheck identity, audience, policy and expiry immediately before dispatch.
        const currentUserId = await dependencies.currentUserId();
        if (currentUserId !== userId) throw new TeamModelPolicyError({ status: "blocked", reason: "identity_mismatch", message: "The current model requester changed." });
        const current = await dependencies.loadAuthority(userId, request.botId);
        const fresh = requireReady(evaluateTeamModelAccess(subject, current, dependencies.routes, dependencies.now()));
        if (JSON.stringify(fresh) !== JSON.stringify(attribution) || JSON.stringify(receipt.attribution) !== JSON.stringify(attribution) || !receipt.id)
          throw new TeamModelPolicyError({ status: "blocked", reason: "invalid_policy", message: "Model access changed while this work was queued. Start it again." });
        dispatchStarted = true;
        return await dependencies.dispatch(input, fresh, receipt.id);
      } catch (error) {
        if (!dispatchStarted) await dependencies.releaseUsage(receipt.id);
        throw error;
      }
    },
  };
}
