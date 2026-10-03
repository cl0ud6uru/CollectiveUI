import { describe, expect, it } from "vitest";
import { ArgumentConstraintSchema, assertArgumentConstraints, ServiceGrantInputSchema, validateConstraintSchema } from "@/lib/bots/service-policy";
import { mcpInputValidator } from "@/lib/mcp/input";
import { AAD, encrypt, toolApprovalSecret } from "@/lib/crypto";
import { mcpErrorMessage, redactMcpValue } from "@/lib/mcp/client";
import { identityClaims, sealIdentitySecret } from "@/lib/mcp/identity";

const caller = { id: "person", upn: "person@example.invalid", email: null };
const scope = [{ path: "project", source: "constant" as const, value: "IT" }, { path: "requester", source: "caller.upn" as const }];
const schema = { type: "object" as const, required: ["project", "requester"], additionalProperties: false,
  properties: { project: { type: "string" }, requester: { type: "string" }, details: { type: "object", additionalProperties: false, properties: { count: { type: "integer" } } } } };

describe("service bot constraints and schema boundary", () => {
  it("requires finite exact scope and cannot disable approval for writes", () => {
    const grant = { serverId: "s", serverRevision: 1, toolName: "write", toolHash: "a".repeat(64), constraints: scope };
    expect(ServiceGrantInputSchema.parse(grant)).toMatchObject({ effect: "write", requireApproval: true });
    expect(ServiceGrantInputSchema.safeParse({ ...grant, requireApproval: false }).success).toBe(false);
    expect(ServiceGrantInputSchema.safeParse({ ...grant, constraints: [] }).success).toBe(false);
    for (const path of ["__proto__.x", "a.constructor", "a.0", "a.prototype"]) expect(ArgumentConstraintSchema.safeParse({ path, source: "constant", value: "x" }).success).toBe(false);
  });
  it("requires own scalar properties, exact caller identity, and a declared matching schema", () => {
    expect(() => validateConstraintSchema({ name: "ticket", inputSchema: schema }, scope)).not.toThrow();
    expect(() => assertArgumentConstraints({ project: "IT", requester: caller.upn }, scope, caller)).not.toThrow();
    for (const input of [{ project: "HR", requester: caller.upn }, { project: "IT", requester: "admin" }, Object.create({ project: "IT", requester: caller.upn }), [], null])
      expect(() => assertArgumentConstraints(input, scope, caller)).toThrow();
    expect(() => assertArgumentConstraints({ email: "" }, [{ path: "email", source: "caller.email" }], caller)).toThrow();
    expect(() => validateConstraintSchema({ name: "ticket", inputSchema: schema }, [{ path: "missing", source: "constant", value: "x" }])).toThrow();
    expect(() => validateConstraintSchema({ name: "ticket", inputSchema: schema }, [{ path: "details.count", source: "constant", value: 1.5 }])).toThrow();
  });
  it("supports repeated schema IDs and draft 2020-12 without retaining registrations", () => {
    for (const dialect of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2020-12/schema"]) {
      for (let n = 0; n < 2; n++) {
        const validate = mcpInputValidator({ ...structuredClone(schema), $id: "urn:fixture:ticket", $schema: dialect }, true);
        expect(() => validate({ project: "IT", requester: caller.upn })).not.toThrow();
        expect(() => validate({ project: 42, requester: caller.upn })).toThrow();
      }
    }
  });
  it("actually validates unknown/nested fields and types without coercion or removal", () => {
    const validate = mcpInputValidator(schema, true);
    const good = { project: "IT", requester: caller.upn, details: { count: 2 } };
    validate(good);
    for (const bad of [null, [], "text", { ...good, adminOverride: true }, { ...good, project: 2 }, { ...good, details: { count: "2" } }, { ...good, details: { admin: true } }, JSON.parse('{"project":"IT","requester":"x","__proto__":{}}')])
      expect(() => validate(bad)).toThrow(/reviewed input schema/);
    expect(good).toEqual({ project: "IT", requester: caller.upn, details: { count: 2 } });
    expect(() => mcpInputValidator({ type: "object", $ref: "https://unused.invalid/schema" }, true)).toThrow();
  });
});

describe("service identity and secret containment", () => {
  it("keeps the human subject and separate confined service context", () => {
    expect(identityClaims({ kind: "user", ...caller, name: "Person", groups: [] }, { audience: "https://fixture.invalid", service: { id: "bot:b", grant: "g", revision: 3, server: "s", tool: "read", call: "call" } })).toMatchObject({ sub: "person", service: { id: "bot:b", grant: "g" } });
    expect(toolApprovalSecret("revision-1")).not.toBe(toolApprovalSecret("revision-2"));
  });
  it("redacts full headers, bare tokens and signing secrets from outputs, keys and errors", () => {
    const token = "synthetic-opaque-bearer", secret = "synthetic-signing-secret";
    const server = { id: "s", headersEnc: encrypt(JSON.stringify({ Authorization: `Bearer ${token}` }), AAD.mcpHeaders), identitySecretEnc: sealIdentitySecret("s", secret) };
    const result = { content: [{ text: `Bearer ${token}; ${token}; ${secret}` }], structuredContent: { [token]: secret } };
    const clean = JSON.stringify(redactMcpValue(result, server));
    expect(clean).not.toContain(token); expect(clean).not.toContain(secret);
    expect(mcpErrorMessage(new Error(`${token} ${secret}`), server)).toBe("[redacted] [redacted]");
    expect(result.content[0].text).toContain(token);
  });
});
