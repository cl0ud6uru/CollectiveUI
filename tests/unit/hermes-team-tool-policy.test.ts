import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HERMES_COMMIT } from "@/local-hermes/config";
import {
  assertTeamToolApproval, authorizeTeamTool, canonicalTeamToolInput, createTeamConnectorService, TeamToolPolicySchema, VERIFIED_TEAM_TOOL_ADAPTERS,
  type TeamToolApproval, type TeamToolAuthority, type TeamToolAttribution, type TeamToolRequest, type VerifiedTeamToolAdapter,
} from "@/lib/hermes-team/tool-policy";

const now = 1000;
const inputSchema = z.object({ documentId: z.string(), text: z.string() }).strict();
const adapter = (): VerifiedTeamToolAdapter => ({
  id: "native-fixture", capabilityId: "documents", action: "document.update", effect: "write",
  evidence: { id: "synthetic-evidence", hermesRevision: HERMES_COMMIT, adapterId: "native-fixture", capabilityId: "documents", action: "document.update", effect: "write", verifiedAt: now - 100, expiresAt: now + 5000 },
  parseInput(input) { const args = inputSchema.parse(input); return { action: "document.update", resourceIds: [args.documentId], arguments: args }; },
});
const authority = (overrides: Partial<TeamToolAuthority> = {}): TeamToolAuthority => ({
  userId: "alice", botId: "bot", userEnabled: true, botEnabled: true, audienceAllowed: true, policyVersion: 1, hermesRevision: HERMES_COMMIT,
  policy: { capabilities: [{ capabilityId: "documents", connectionMode: "approved_team_connection", connectionId: "team-connection", adapterId: "native-fixture", action: "document.update", resourceIds: ["approved-document"], effect: "write", requireApproval: true }] },
  connection: { id: "team-connection", mode: "approved_team_connection", version: 1, status: "active", expiresAt: now + 5000, approvedForBotId: "bot" },
  ...overrides,
});
const request = (overrides: Partial<TeamToolRequest> = {}): TeamToolRequest => ({ botId: "bot", runId: "run", capabilityId: "documents", input: { documentId: "approved-document", text: "synthetic text" }, ...overrides });
const authorize = (state = authority(), toolRequest = request(), adapters = [adapter()]) => authorizeTeamTool("alice", toolRequest, state, adapters, now);
const approval = (attribution = authorize().attribution, overrides: Partial<TeamToolApproval> = {}): TeamToolApproval => ({
  id: "approval", userId: attribution.userId, botId: attribution.botId, runId: attribution.runId, policyVersion: attribution.policyVersion,
  capabilityId: attribution.capabilityId, connectionId: attribution.connectionId, connectionVersion: attribution.connectionVersion,
  inputHash: attribution.inputHash, status: "approved", expiresAt: now + 1000, ...overrides,
});

function connectorFixture(state = authority(), adapters = [adapter()]) {
  let current = state;
  let clock = now;
  let actor = "alice";
  const loadAuthority = vi.fn(async () => current);
  const loadApproval = vi.fn(async () => approval(authorize(current, request(), adapters).attribution));
  const dispatch = vi.fn(async (argumentsValue: unknown, attribution: TeamToolAttribution, approvalId: string | null) => ({ argumentsValue, attribution, approvalId }));
  const service = createTeamConnectorService({ currentUserId: async () => actor, loadAuthority, loadApproval, dispatch, adapters, now: () => clock });
  return { service, loadAuthority, loadApproval, dispatch, setState: (next: TeamToolAuthority) => { current = next; },
    setClock: (time: number) => { clock = time; }, setActor: (userId: string) => { actor = userId; } };
}

describe("Team Bot fixed native tool capability policy", () => {
  it("ships no enabled native adapters; app MCP grants do not authorize native Hermes tools", () => {
    expect(VERIFIED_TEAM_TOOL_ADAPTERS).toEqual([]);
    expect(Object.isFrozen(VERIFIED_TEAM_TOOL_ADAPTERS)).toBe(true);
    expect(() => authorizeTeamTool("alice", request(), authority(), undefined, now)).toThrow("not been verified");
  });

  it("requires one exact capability configuration, explicit scope and mandatory write approval", () => {
    const capability = authority().policy.capabilities[0];
    expect(TeamToolPolicySchema.safeParse(authority().policy).success).toBe(true);
    for (const invalid of [
      { capabilities: [capability, capability] },
      { capabilities: [{ ...capability, resourceIds: [] }] },
      { capabilities: [{ ...capability, connectionId: undefined }] },
      { capabilities: [{ ...capability, requireApproval: false }] },
      { capabilities: [{ ...capability, token: "synthetic-secret" }] },
      { capabilities: [{ ...capability, connectionMode: "ask_each_time" }] },
    ]) expect(TeamToolPolicySchema.safeParse(invalid).success).toBe(false);
    expect(() => authorize(authority({ policy: { capabilities: [{ ...capability, connectionMode: "disabled" }] } }))).toThrow("disabled");
    expect(() => authorize(authority(), request({ capabilityId: "shell" }))).toThrow("disabled");
  });

  it("requires exact native bridge evidence for the pin, adapter, capability, action and effect", () => {
    const verified = adapter();
    const variants: VerifiedTeamToolAdapter[] = [
      { ...verified, action: "document.delete" }, { ...verified, effect: "read" },
      { ...verified, evidence: { ...verified.evidence, hermesRevision: "a".repeat(40) } },
      { ...verified, evidence: { ...verified.evidence, adapterId: "app-mcp" } },
      { ...verified, evidence: { ...verified.evidence, capabilityId: "browser" } },
      { ...verified, evidence: { ...verified.evidence, action: "document.delete" } },
      { ...verified, evidence: { ...verified.evidence, effect: "read" } },
      { ...verified, evidence: { ...verified.evidence, verifiedAt: now + 1 } },
      { ...verified, evidence: { ...verified.evidence, expiresAt: now } },
    ];
    for (const candidate of variants) expect(() => authorize(authority(), request(), [candidate])).toThrow("not been verified");
    expect(() => authorize(authority(), request(), [verified, verified])).toThrow("not been verified");
  });

  it("derives resource scope from validated arguments and rejects forged or extra scope fields", () => {
    expect(authorize()).toMatchObject({ attribution: { userId: "alice", botId: "bot", action: "document.update", resourceIds: ["approved-document"], connectionId: "team-connection" } });
    expect(() => authorize(authority(), request({ input: { documentId: "private-document", text: "x" } }))).toThrow("outside");
    expect(() => authorize(authority(), request({ input: { documentId: "approved-document", text: "x", resourceId: "approved-document", action: "document.delete" } }))).toThrow();
    const forged = { ...adapter(), parseInput: () => ({ action: "document.delete", resourceIds: ["approved-document"], arguments: {} }) };
    expect(() => authorize(authority(), request(), [forged])).toThrow("outside");
    const empty = { ...adapter(), parseInput: () => ({ action: "document.update", resourceIds: [], arguments: {} }) };
    expect(() => authorize(authority(), request(), [empty])).toThrow("outside");
  });

  it("binds team connections to the bot and personal connections to the current member", () => {
    const connection = authority().connection!;
    for (const bad of [null, { ...connection, id: "other" }, { ...connection, approvedForBotId: "another-bot" },
      { ...connection, status: "revoked" as const }, { ...connection, expiresAt: now }, { ...connection, version: 0 }])
      expect(() => authorize(authority({ connection: bad }))).toThrow("connection needs attention");
    const member = authority({
      policy: { capabilities: [{ ...authority().policy.capabilities[0], connectionMode: "member_connection", connectionId: "member-connection" }] },
      connection: { id: "member-connection", mode: "member_connection", userId: "alice", version: 1, status: "active", expiresAt: now + 1000 },
    });
    expect(authorize(member).attribution.connectionMode).toBe("member_connection");
    expect(() => authorize({ ...member, connection: { ...member.connection!, userId: "bob" } })).toThrow("Connect your account");
  });

  it("revokes capabilities when the actor, bot or audience is disabled; ownership alone is insufficient", () => {
    for (const state of [authority({ userEnabled: false }), authority({ botEnabled: false }), authority({ audienceAllowed: false })])
      expect(() => authorize(state)).toThrow("no longer have access");
    for (const state of [authority({ userId: "bob" }), authority({ botId: "another-bot" })])
      expect(() => authorize(state)).toThrow("identity");
  });

  it("canonicalizes approval hashes, bounds input and rejects prototype/accessor payloads without executing getters", () => {
    const first = authorize(authority(), request({ input: { documentId: "approved-document", text: "same" } }));
    const reordered = authorize(authority(), request({ input: { text: "same", documentId: "approved-document" } }));
    expect(first.attribution.inputHash).toBe(reordered.attribution.inputHash);
    expect(first.attribution.inputHash).not.toBe(authorize().attribution.inputHash);
    const getter = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "documentId", { enumerable: true, get: getter });
    const arrayGetter = Object.defineProperty([], "0", { enumerable: true, get: getter });
    const nested: unknown[] = []; nested.push(nested);
    for (const invalid of [Object.create({ documentId: "approved-document" }), accessor, arrayGetter, nested,
      JSON.parse('{"__proto__":{}}'), JSON.parse('{"constructor":{}}'), undefined, Infinity, new Date(), "x".repeat(64001), Array(2)])
      expect(() => canonicalTeamToolInput(invalid)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("Team Bot human approval continuation", () => {
  it("binds approval to person, bot, run, policy, connection version and exact arguments", () => {
    const attribution = authorize().attribution;
    expect(() => assertTeamToolApproval(attribution, approval(), now)).not.toThrow();
    expect(() => assertTeamToolApproval(attribution, null, now)).toThrow("approve");
    expect(() => assertTeamToolApproval(attribution, approval(attribution, { status: "pending" }), now)).toThrow("approve");
    for (const overrides of [
      { userId: "bob" }, { botId: "other-bot" }, { runId: "other-run" }, { policyVersion: 2 },
      { capabilityId: "shell" }, { connectionId: "personal" }, { connectionVersion: 2 }, { inputHash: "other-hash" }, { expiresAt: now },
    ]) expect(() => assertTeamToolApproval(attribution, approval(attribution, overrides), now)).toThrow("changed");
  });

  it("dispatches only reviewed arguments and attribution through the server connector boundary", async () => {
    const fixture = connectorFixture();
    const result = await fixture.service.execute(request({ approvalId: "approval" }));
    expect(result).toMatchObject({ argumentsValue: { documentId: "approved-document", text: "synthetic text" }, approvalId: "approval",
      attribution: { userId: "alice", botId: "bot", runId: "run", connectionMode: "approved_team_connection", requireApproval: true } });
    expect(fixture.loadAuthority).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/credential|token|profilePath/);
  });

  it("does not dispatch unverified native tools or unapproved writes", async () => {
    const unsupported = connectorFixture(authority(), []);
    await expect(unsupported.service.execute(request({ approvalId: "approval" }))).rejects.toMatchObject({ reason: "adapter_unverified" });
    expect(unsupported.loadApproval).not.toHaveBeenCalled();
    expect(unsupported.dispatch).not.toHaveBeenCalled();
    const unapproved = connectorFixture();
    await expect(unapproved.service.execute(request())).rejects.toMatchObject({ reason: "approval_needed" });
    expect(unapproved.dispatch).not.toHaveBeenCalled();
  });

  it("checks fresh access after approval so audience removal blocks continuation", async () => {
    const fixture = connectorFixture();
    fixture.loadApproval.mockImplementationOnce(async () => { fixture.setState(authority({ audienceAllowed: false })); return approval(); });
    await expect(fixture.service.execute(request({ approvalId: "approval" }))).rejects.toMatchObject({ reason: "access_revoked" });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a policy change, credential rotation, expired connection, changed actor or substituted approval during continuation", async () => {
    for (const mutation of ["policy", "connection", "expired", "actor", "approval"] as const) {
      const fixture = connectorFixture();
      fixture.loadApproval.mockImplementationOnce(async () => {
        if (mutation === "policy") fixture.setState(authority({ policyVersion: 2 }));
        if (mutation === "connection") fixture.setState(authority({ connection: { ...authority().connection!, version: 2 } }));
        if (mutation === "expired") fixture.setClock(now + 5000);
        if (mutation === "actor") fixture.setActor("bob");
        return approval(undefined, mutation === "approval" ? { id: "substituted-approval" } : {});
      });
      await expect(fixture.service.execute(request({ approvalId: "approval" }))).rejects.toMatchObject({ name: "TeamToolPolicyError" });
      expect(fixture.dispatch).not.toHaveBeenCalled();
    }
  });

  it("rejects an argument changed while waiting for approval", async () => {
    const fixture = connectorFixture();
    const toolRequest = request({ approvalId: "approval" });
    fixture.loadApproval.mockImplementationOnce(async () => { toolRequest.input = { documentId: "approved-document", text: "different write" }; return approval(); });
    await expect(fixture.service.execute(toolRequest)).rejects.toMatchObject({ reason: "approval_stale" });
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("derives the human from the current session instead of any native request identity", async () => {
    const fixture = connectorFixture();
    await fixture.service.execute({ ...request({ approvalId: "approval" }), userId: "bob" } as TeamToolRequest);
    expect(fixture.loadAuthority).toHaveBeenCalledWith("alice", "bot", "documents");
    expect(fixture.dispatch.mock.calls[0][1].userId).toBe("alice");
  });
});
