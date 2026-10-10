import { describe, expect, it, vi } from "vitest";
import { HERMES_COMMIT } from "@/local-hermes/config";
import {
  createTeamModelGateway, evaluateTeamModelAccess, TEAM_MODEL_PURPOSES, TeamModelPolicySchema, VERIFIED_TEAM_MODEL_ROUTES,
  type TeamModelAuthority, type TeamModelAttribution, type TeamModelRequest, type VerifiedTeamModelRoute,
} from "@/lib/hermes-team/model-policy";

// Synthetic evidence verifies only this contract fixture; neither route is installed by production code.
const now = 1000;
const route = (billing: "personal" | "admin" = "personal"): VerifiedTeamModelRoute => {
  const integration = billing === "admin" ? "admin_inference_gateway" : "hermes_native_codex";
  return { id: billing, adapterId: `fixture-${billing}`, integration, model: "fixture-model", billing, credentialHandling: "server_gateway",
    evidence: { id: "synthetic-evidence", hermesRevision: HERMES_COMMIT, adapterId: `fixture-${billing}`, integration, model: "fixture-model", purposes: [...TEAM_MODEL_PURPOSES], verifiedAt: now - 100, expiresAt: now + 5000 } };
};
const authority = (overrides: Partial<TeamModelAuthority> = {}): TeamModelAuthority => ({
  userId: "alice", botId: "bot", userEnabled: true, botEnabled: true, audienceAllowed: true, policyVersion: 1, hermesRevision: HERMES_COMMIT,
  policy: { mode: "personal_required", adminRouteId: "admin", personalRouteId: "personal" },
  personalConnection: { id: "alice-connection", userId: "alice", integration: "hermes_native_codex", status: "active", expiresAt: now + 5000 },
  ...overrides,
});
const request = (overrides: Partial<TeamModelRequest> = {}): TeamModelRequest => ({ botId: "bot", runId: "run", purpose: "reply", ...overrides });
const evaluate = (state: TeamModelAuthority, routes = [route(), route("admin")], modelRequest = request()) => evaluateTeamModelAccess({ ...modelRequest, userId: "alice" }, state, routes, now);

function gatewayFixture(state = authority(), routes = [route(), route("admin")]) {
  let current = state;
  let clock = now;
  let actor = "alice";
  const reserveUsage = vi.fn(async (attribution: TeamModelAttribution) => ({ id: "usage-receipt", attribution: structuredClone(attribution) }));
  const releaseUsage = vi.fn(async () => undefined);
  const dispatch = vi.fn(async (_input: unknown, attribution: TeamModelAttribution) => ({ route: attribution.routeId, billing: attribution.billing }));
  const loadAuthority = vi.fn(async () => current);
  const gateway = createTeamModelGateway({
    currentUserId: async () => actor, loadAuthority, routes, now: () => clock, reserveUsage, releaseUsage, dispatch,
  });
  return { gateway, reserveUsage, releaseUsage, dispatch, loadAuthority, setState: (next: TeamModelAuthority) => { current = next; },
    setClock: (time: number) => { clock = time; }, setActor: (userId: string) => { actor = userId; } };
}

describe("Team Bot model route admission", () => {
  it("ships no enabled model routes and rejects a successful login without tested model access", () => {
    expect(VERIFIED_TEAM_MODEL_ROUTES).toEqual([]);
    expect(Object.isFrozen(VERIFIED_TEAM_MODEL_ROUTES)).toBe(true);
    for (const purpose of TEAM_MODEL_PURPOSES)
      expect(evaluateTeamModelAccess({ ...request({ purpose }), userId: "alice" }, authority(), undefined, now)).toMatchObject({ status: "connection_needed", reason: "route_unverified" });
  });

  it("requires exact Hermes pin, adapter, model, integration and all native work categories", () => {
    const verified = route();
    const variants: VerifiedTeamModelRoute[] = [
      { ...verified, model: "new-model" }, { ...verified, adapterId: "new-adapter" },
      { ...verified, evidence: { ...verified.evidence, hermesRevision: "a".repeat(40) } },
      { ...verified, evidence: { ...verified.evidence, integration: "openai_chatgpt_plan_usage" } },
      { ...verified, evidence: { ...verified.evidence, verifiedAt: now + 1 } },
      { ...verified, evidence: { ...verified.evidence, expiresAt: now } },
      ...TEAM_MODEL_PURPOSES.map((missing) => ({ ...verified, evidence: { ...verified.evidence, purposes: TEAM_MODEL_PURPOSES.filter((p) => p !== missing) } })),
    ];
    for (const candidate of variants) expect(evaluate(authority(), [candidate])).toMatchObject({ status: "connection_needed", reason: "route_unverified" });
    expect(evaluate(authority(), [verified, verified])).toMatchObject({ reason: "route_unverified" });
    expect(evaluate(authority({ hermesRevision: "v2026.9.24" }))).toMatchObject({ reason: "route_unverified" });
  });

  it("does not treat native Codex login as official ChatGPT plan-usage verification", () => {
    const codex = route();
    const official = { ...codex, integration: "openai_chatgpt_plan_usage" as const, evidence: { ...codex.evidence, integration: "openai_chatgpt_plan_usage" as const } };
    expect(evaluate(authority(), [official])).toMatchObject({ status: "connection_needed", reason: "personal_connection_needed" });
    const connection = { ...authority().personalConnection!, integration: "openai_chatgpt_plan_usage" as const, workspaceId: 'work' };
    expect(evaluate(authority({ personalConnection: connection }), [official])).toMatchObject({ status: 'ready' });
    expect(evaluate(authority({ policy: { mode: 'personal_required', personalRouteId: 'personal', personalWorkspaceId: 'work' }, personalConnection: connection }), [official])).toMatchObject({ status: "ready" });
    for (const workspaceId of [undefined, 'other']) expect(evaluate(authority({ policy: { mode: 'personal_required', personalRouteId: 'personal', personalWorkspaceId: 'work' }, personalConnection: { ...connection, workspaceId } }), [official])).toMatchObject({ reason: 'personal_workspace_mismatch' });
  });

  it("requires the current human's unexpired connection and never selects the admin route in required-personal mode", () => {
    for (const purpose of TEAM_MODEL_PURPOSES)
      expect(evaluate(authority(), undefined, request({ purpose }))).toMatchObject({ status: "ready", attribution: { billing: "personal", routeId: "personal", purpose, userId: "alice" } });
    const connection = authority().personalConnection!;
    for (const personalConnection of [null, { ...connection, userId: "bob" }, { ...connection, status: "revoked" as const }])
      expect(evaluate(authority({ personalConnection }))).toMatchObject({ status: "connection_needed", reason: "personal_connection_needed" });
    for (const personalConnection of [{ ...connection, status: "expired" as const }, { ...connection, expiresAt: now }, { ...connection, expiresAt: NaN }])
      expect(evaluate(authority({ personalConnection }))).toMatchObject({ status: "connection_needed", reason: "personal_connection_expired" });
    expect(evaluate(authority({ policy: { mode: "personal_required", adminRouteId: "admin" } }))).toMatchObject({ reason: "route_unverified" });
  });

  it("fixes admin billing and honors an explicit personal choice without fallback", () => {
    expect(evaluate(authority({ policy: { mode: "admin_provided", adminRouteId: "admin" } }))).toMatchObject({ status: "ready", attribution: { billing: "admin", connectionId: null } });
    expect(evaluate(authority({ policy: { mode: "admin_provided", adminRouteId: "admin" } }), undefined, request({ choice: "personal" }))).toMatchObject({ reason: "personal_not_allowed" });
    const optional = authority({ policy: { mode: "admin_default_personal_allowed", adminRouteId: "admin", personalRouteId: "personal" } });
    expect(evaluate(optional)).toMatchObject({ status: "ready", attribution: { billing: "admin" } });
    expect(evaluate(optional, undefined, request({ choice: "personal" }))).toMatchObject({ status: "ready", attribution: { billing: "personal" } });
    expect(evaluate({ ...optional, personalConnection: null }, undefined, request({ choice: "personal" }))).toMatchObject({ reason: "personal_connection_needed" });
  });

  it("rejects disabled actors, removed audience membership, mismatched ownership and policy tampering", () => {
    for (const state of [authority({ userEnabled: false }), authority({ botEnabled: false }), authority({ audienceAllowed: false })])
      expect(evaluate(state)).toMatchObject({ status: "blocked", reason: "access_revoked" });
    for (const state of [authority({ userId: "bob" }), authority({ botId: "another-bot" })])
      expect(evaluate(state)).toMatchObject({ reason: "identity_mismatch" });
    expect(evaluate(authority({ policyVersion: 0 }))).toMatchObject({ reason: "invalid_policy" });
    expect(TeamModelPolicySchema.safeParse({ mode: "personal_required", token: "synthetic-secret" }).success).toBe(false);
    expect(TeamModelPolicySchema.safeParse({ mode: "fallback_to_admin" }).success).toBe(false);
    expect(evaluate(authority(), undefined, request({ purpose: "unknown" as "reply" }))).toMatchObject({ reason: "invalid_request" });
  });
});

describe("Team Bot server inference gateway boundary", () => {
  it("attributes every required-personal work category with zero company-provider calls", async () => {
    const fixture = gatewayFixture();
    for (const purpose of TEAM_MODEL_PURPOSES) {
      expect(await fixture.gateway.execute(request({ purpose }), { prompt: "synthetic prompt" })).toEqual({ route: "personal", billing: "personal" });
      expect(fixture.dispatch.mock.lastCall?.[1]).toMatchObject({ userId: "alice", botId: "bot", runId: "run", policyVersion: 1, purpose, billing: "personal", connectionId: "alice-connection" });
    }
    expect(fixture.dispatch.mock.calls.filter(([, attribution]) => attribution.billing === "admin")).toHaveLength(0);
    expect(fixture.loadAuthority).toHaveBeenCalledTimes(8);
    expect(fixture.releaseUsage).not.toHaveBeenCalled();
  });

  it("never dispatches when no tested route exists, even if authenticated", async () => {
    const fixture = gatewayFixture(authority(), []);
    await expect(fixture.gateway.execute(request(), {})).rejects.toMatchObject({ decision: { status: "connection_needed", reason: "route_unverified" } });
    expect(fixture.reserveUsage).not.toHaveBeenCalled();
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("blocks revocation during queuing and releases the reserved usage receipt", async () => {
    const fixture = gatewayFixture();
    fixture.reserveUsage.mockImplementationOnce(async (attribution) => {
      fixture.setState(authority({ audienceAllowed: false }));
      return { id: "usage-receipt", attribution };
    });
    await expect(fixture.gateway.execute(request({ purpose: "utility" }), {})).rejects.toMatchObject({ decision: { reason: "access_revoked" } });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.releaseUsage).toHaveBeenCalledExactlyOnceWith("usage-receipt");
  });

  it("pauses when personal access expires during queuing without admin fallback", async () => {
    const fixture = gatewayFixture();
    fixture.reserveUsage.mockImplementationOnce(async (attribution) => { fixture.setClock(now + 5000); return { id: "usage-receipt", attribution }; });
    await expect(fixture.gateway.execute(request({ purpose: "learning" }), {})).rejects.toMatchObject({ decision: { status: "connection_needed" } });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.releaseUsage).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed personal dispatch on a company route", async () => {
    const fixture = gatewayFixture();
    fixture.dispatch.mockRejectedValueOnce(new Error("synthetic model failure"));
    await expect(fixture.gateway.execute(request({ purpose: "subagent" }), {})).rejects.toThrow("synthetic model failure");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0][1].billing).toBe("personal");
    // An unsuccessful response may still be billable; the adapter owns conservative usage settlement.
    expect(fixture.releaseUsage).not.toHaveBeenCalled();
  });

  it("rejects a changed actor, policy version and tampered limit attribution before dispatch", async () => {
    for (const mutation of ["actor", "policy", "receipt"] as const) {
      const fixture = gatewayFixture();
      fixture.reserveUsage.mockImplementationOnce(async (attribution) => {
        if (mutation === "actor") fixture.setActor("bob");
        if (mutation === "policy") fixture.setState(authority({ policyVersion: 2 }));
        return { id: "usage-receipt", attribution: mutation === "receipt" ? { ...attribution, billing: "admin" } : attribution };
      });
      await expect(fixture.gateway.execute(request(), {})).rejects.toMatchObject({ name: "TeamModelPolicyError" });
      expect(fixture.dispatch).not.toHaveBeenCalled();
      expect(fixture.releaseUsage).toHaveBeenCalledTimes(1);
    }
  });

  it("derives the current person from the server and denies exhausted limits before any model call", async () => {
    const fixture = gatewayFixture();
    fixture.reserveUsage.mockRejectedValueOnce(new Error("Synthetic usage limit reached"));
    await expect(fixture.gateway.execute({ ...request(), userId: "bob" } as TeamModelRequest, {})).rejects.toThrow("usage limit");
    expect(fixture.loadAuthority).toHaveBeenCalledWith("alice", "bot");
    expect(fixture.reserveUsage.mock.calls[0][0].userId).toBe("alice");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
