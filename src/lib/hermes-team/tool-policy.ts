import { createHash } from "node:crypto";
import { z } from "zod";

const identifier = z.string().min(1).max(200);
export const TeamToolCapabilitySchema = z.object({
  capabilityId: identifier,
  connectionMode: z.enum(["approved_team_connection", "member_connection", "disabled"]),
  connectionId: identifier.optional(),
  adapterId: identifier.optional(),
  action: identifier.optional(),
  resourceIds: z.array(identifier).max(100).default([]),
  effect: z.enum(["read", "write"]).default("read"),
  requireApproval: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.connectionMode !== "disabled" && (!value.connectionId || !value.adapterId || !value.action || !value.resourceIds.length))
    context.addIssue({ code: "custom", message: "Enabled capabilities need a fixed connection, verified adapter, action and resource scope." });
  if (value.effect === "write" && !value.requireApproval)
    context.addIssue({ code: "custom", message: "Writes always require human approval." });
});
export type TeamToolCapability = z.infer<typeof TeamToolCapabilitySchema>;
export const TeamToolPolicySchema = z.object({ capabilities: z.array(TeamToolCapabilitySchema).max(100) }).strict().superRefine((value, context) => {
  if (new Set(value.capabilities.map((c) => c.capabilityId)).size !== value.capabilities.length)
    context.addIssue({ code: "custom", message: "Each capability must have one fixed configuration." });
});
export type TeamToolPolicy = z.infer<typeof TeamToolPolicySchema>;

export type ScopedTeamToolInput = { action: string; resourceIds: readonly string[]; arguments: unknown };
export type VerifiedTeamToolAdapter = {
  id: string;
  capabilityId: string;
  action: string;
  effect: "read" | "write";
  /** Explicit native Hermes bridge evidence. Existing app MCP authorization is insufficient. */
  evidence: { id: string; hermesRevision: string; adapterId: string; capabilityId: string; action: string; effect: "read" | "write"; verifiedAt: number; expiresAt: number };
  /** Derive the actual action/resources from validated native arguments. Never trust a caller's claimed scope. */
  parseInput(input: unknown): ScopedTeamToolInput;
};
export const VERIFIED_TEAM_TOOL_ADAPTERS: readonly VerifiedTeamToolAdapter[] = Object.freeze([]);
export type TeamToolConnection = {
  id: string;
  version: number;
  mode: "approved_team_connection" | "member_connection";
  status: "active" | "expired" | "revoked";
  expiresAt: number;
  /** Team service grants are bound to this bot. Personal credentials are bound to the current member. */
  approvedForBotId?: string;
  userId?: string;
};
export type TeamToolAuthority = {
  userId: string;
  botId: string;
  userEnabled: boolean;
  botEnabled: boolean;
  audienceAllowed: boolean;
  policyVersion: number;
  hermesRevision: string;
  policy: TeamToolPolicy;
  connection?: TeamToolConnection | null;
};
export type TeamToolRequest = { botId: string; runId: string; capabilityId: string; input: unknown; approvalId?: string };
export type TeamToolAttribution = {
  userId: string;
  botId: string;
  runId: string;
  policyVersion: number;
  capabilityId: string;
  adapterId: string;
  connectionId: string;
  connectionVersion: number;
  connectionMode: "approved_team_connection" | "member_connection";
  action: string;
  resourceIds: readonly string[];
  inputHash: string;
  requireApproval: boolean;
};
export type TeamToolApproval = {
  id: string;
  userId: string;
  botId: string;
  runId: string;
  policyVersion: number;
  capabilityId: string;
  connectionId: string;
  connectionVersion: number;
  inputHash: string;
  status: "approved" | "rejected" | "pending";
  expiresAt: number;
};
export class TeamToolPolicyError extends Error {
  constructor(public readonly reason: "access_revoked" | "identity_mismatch" | "invalid_policy" | "disabled" | "adapter_unverified"
    | "connection_needed" | "out_of_scope" | "approval_needed" | "approval_stale", message: string) {
    super(message);
    this.name = "TeamToolPolicyError";
  }
}
const reject = (reason: TeamToolPolicyError["reason"], message: string): never => { throw new TeamToolPolicyError(reason, message); };

/** Canonical bounded data only, for a stable approval binding and safe server connector payload. */
export function canonicalTeamToolInput(input: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const consume = (size: number) => {
    bytes += size;
    if (bytes > 64000) return reject("out_of_scope", "Tool input exceeds the supported bounds.");
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 20) return reject("out_of_scope", "Tool input exceeds the supported bounds.");
    if (typeof value === "string") { consume(Buffer.byteLength(value, "utf8") + 2); return value; }
    if (value === null || typeof value === "boolean") { consume(value === false ? 5 : 4); return value; }
    if (typeof value === "number" && Number.isFinite(value)) { consume(String(value).length); return value; }
    if (Array.isArray(value)) {
      consume(2 + Math.max(0, value.length - 1));
      const copied: unknown[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) return reject("out_of_scope", "Tool arrays must contain plain data.");
        copied.push(visit(descriptor.value, depth + 1));
      }
      return copied;
    }
    if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      return reject("out_of_scope", "Tool input must contain plain JSON data.");
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value).sort();
    consume(2 + Math.max(0, keys.length - 1));
    for (const key of keys) {
      consume(Buffer.byteLength(key, "utf8") + 3);
      if (["__proto__", "constructor", "prototype"].includes(key)) return reject("out_of_scope", "Unsafe tool input key.");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return reject("out_of_scope", "Tool input cannot contain accessors.");
      sorted[key] = visit(descriptor.value, depth + 1);
    }
    return sorted;
  };
  const serialized = JSON.stringify(visit(input, 0));
  if (Buffer.byteLength(serialized, "utf8") > 64000) return reject("out_of_scope", "Tool input exceeds the supported bounds.");
  return serialized;
}

/** Pure policy checks over fresh, server-owned state. Native Hermes tools get no implicit app/MCP grant. */
export function authorizeTeamTool(
  userId: string,
  request: TeamToolRequest,
  authority: TeamToolAuthority,
  adapters: readonly VerifiedTeamToolAdapter[] = VERIFIED_TEAM_TOOL_ADAPTERS,
  now = Date.now(),
): { attribution: TeamToolAttribution; arguments: unknown } {
  if (!userId || authority.userId !== userId || !request.botId || authority.botId !== request.botId)
    return reject("identity_mismatch", "Team tool identity does not match the current person and bot.");
  if (authority.userEnabled !== true || authority.botEnabled !== true || authority.audienceAllowed !== true)
    return reject("access_revoked", "You no longer have access to this Team Bot.");
  const parsed = TeamToolPolicySchema.safeParse(authority.policy);
  if (!parsed.success || !request.runId || !Number.isSafeInteger(authority.policyVersion) || authority.policyVersion < 1 || !Number.isFinite(now))
    return reject("invalid_policy", "The Team Bot tool policy needs attention.");
  const capability = parsed.data.capabilities.find((c) => c.capabilityId === request.capabilityId);
  if (!capability || capability.connectionMode === "disabled") return reject("disabled", "This capability is disabled for this bot.");
  const matching = adapters.filter((a) => a.id === capability.adapterId);
  const adapter = matching.length === 1 ? matching[0] : undefined;
  const evidence = adapter?.evidence;
  if (!adapter || !evidence || !/^[a-f0-9]{40}$/.test(authority.hermesRevision) || !evidence.id
    || adapter.capabilityId !== capability.capabilityId || adapter.action !== capability.action || adapter.effect !== capability.effect
    || evidence.hermesRevision !== authority.hermesRevision || evidence.adapterId !== adapter.id
    || evidence.capabilityId !== adapter.capabilityId || evidence.action !== adapter.action || evidence.effect !== adapter.effect
    || !Number.isFinite(evidence.verifiedAt) || evidence.verifiedAt > now || !Number.isFinite(evidence.expiresAt) || evidence.expiresAt <= now)
    return reject("adapter_unverified", "This native Hermes tool route has not been verified.");
  const connection = authority.connection;
  if (!connection || !connection.id || connection.id !== capability.connectionId || connection.mode !== capability.connectionMode
    || connection.status !== "active" || !Number.isFinite(connection.expiresAt) || connection.expiresAt <= now
    || !Number.isSafeInteger(connection.version) || connection.version < 1
    || (connection.mode === "approved_team_connection" ? connection.approvedForBotId !== request.botId : connection.userId !== userId))
    return reject("connection_needed", capability.connectionMode === "member_connection" ? "Connect your account to use this capability." : "This bot's team connection needs attention.");
  // Clone plain input before parsing so the adapter cannot accidentally pass hidden, inherited or mutable caller state.
  const raw = JSON.parse(canonicalTeamToolInput(request.input));
  const scoped = adapter.parseInput(raw);
  if (scoped.action !== capability.action || !scoped.resourceIds.length || scoped.resourceIds.some((id) => !capability.resourceIds.includes(id)))
    return reject("out_of_scope", "The requested action or resource is outside this bot's approved scope.");
  const resourceIds = [...new Set(scoped.resourceIds)].sort();
  const argumentsJson = canonicalTeamToolInput(scoped.arguments);
  const inputHash = createHash("sha256").update(canonicalTeamToolInput({ action: scoped.action, resourceIds, arguments: JSON.parse(argumentsJson) })).digest("hex");
  return { attribution: {
    userId, botId: request.botId, runId: request.runId, policyVersion: authority.policyVersion, capabilityId: capability.capabilityId,
    adapterId: adapter.id, connectionId: connection.id, connectionVersion: connection.version, connectionMode: connection.mode,
    action: scoped.action, resourceIds, inputHash, requireApproval: capability.requireApproval || capability.effect === "write",
  }, arguments: JSON.parse(argumentsJson) };
}

export function assertTeamToolApproval(attribution: TeamToolAttribution, approval: TeamToolApproval | null, now: number): void {
  if (!attribution.requireApproval) return;
  if (!approval || approval.status !== "approved") return reject("approval_needed", "Review and approve this action before it runs.");
  if (!approval.id || !Number.isFinite(now) || !Number.isFinite(approval.expiresAt) || approval.expiresAt <= now
    || approval.userId !== attribution.userId || approval.botId !== attribution.botId || approval.runId !== attribution.runId
    || approval.policyVersion !== attribution.policyVersion || approval.capabilityId !== attribution.capabilityId
    || approval.connectionId !== attribution.connectionId || approval.connectionVersion !== attribution.connectionVersion || approval.inputHash !== attribution.inputHash)
    return reject("approval_stale", "This tool action changed. Review it again.");
}

export type TeamConnectorDependencies<Output> = {
  currentUserId(): Promise<string>;
  loadAuthority(userId: string, botId: string, capabilityId: string): Promise<TeamToolAuthority>;
  adapters: readonly VerifiedTeamToolAdapter[];
  now(): number;
  /** Server approval storage must enforce single-use continuation/idempotent execution receipts. */
  loadApproval(id: string): Promise<TeamToolApproval | null>;
  /** Must atomically consume approval, enforce attribution/current authorization and return an idempotent execution receipt. */
  dispatch(argumentsValue: unknown, attribution: TeamToolAttribution, approvalId: string | null): Promise<Output>;
};

/** Future connector-service boundary. Company credentials are resolved only inside dispatch, never returned to profiles. */
export function createTeamConnectorService<Output>(dependencies: TeamConnectorDependencies<Output>) {
  return {
    async execute(request: TeamToolRequest): Promise<Output> {
      const userId = await dependencies.currentUserId();
      const authority = await dependencies.loadAuthority(userId, request.botId, request.capabilityId);
      const first = authorizeTeamTool(userId, request, authority, dependencies.adapters, dependencies.now());
      const approval = request.approvalId ? await dependencies.loadApproval(request.approvalId) : null;
      if (approval && approval.id !== request.approvalId) return reject("approval_stale", "The tool approval does not match this continuation.");
      assertTeamToolApproval(first.attribution, approval, dependencies.now());
      // Waiting for approval does not retain audience access. Revalidate both authorization and its exact payload.
      if (await dependencies.currentUserId() !== userId) return reject("identity_mismatch", "The current tool requester changed.");
      const freshAuthority = await dependencies.loadAuthority(userId, request.botId, request.capabilityId);
      const fresh = authorizeTeamTool(userId, request, freshAuthority, dependencies.adapters, dependencies.now());
      if (canonicalTeamToolInput(first.attribution) !== canonicalTeamToolInput(fresh.attribution))
        return reject("approval_stale", "Tool access changed while this action was queued. Review it again.");
      assertTeamToolApproval(fresh.attribution, approval, dependencies.now());
      return dependencies.dispatch(fresh.arguments, fresh.attribution, fresh.attribution.requireApproval ? approval!.id : null);
    },
  };
}
