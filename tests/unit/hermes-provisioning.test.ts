import { describe, expect, it } from "vitest";
import { HERMES_PROTOCOL, connectionInput, loopbackUrl } from "@/lib/hermes-provisioning/config";
import { ProfileProtocol } from "@/lib/hermes-provisioning/protocol";
import { ProvisioningMock } from "../fixtures/hermes/provisioning-mock";
import { createHash } from "node:crypto";
import { hermesTargetKey } from "@/lib/llm/providers/hermes/scope";
import { getRun, runEvents } from "@/lib/llm/providers/hermes/client";

const name = "cui-" + "a".repeat(32);
const config = { provider: "openai" as const, model: "mock-model", skills: [], toolsets: [] };
const secret = { dashboardToken: "synthetic-dashboard-key", providerKey: "synthetic-provider-key", profileKeys: ["synthetic-profile-key"] };
const connection = { dashboardUrl: "http://127.0.0.1:19000", runsUrl: "http://127.0.0.1:19001", protocol: HERMES_PROTOCOL, expectedVersion: "mock-pinned", expectedDisplayVersion: "mock-pinned" };
const fixture = () => { const mock = new ProvisioningMock(); return { mock, protocol: new ProfileProtocol(connection, secret, mock.fetch) }; };
describe("pinned Hermes management protocol (synthetic transport)", () => {
  it("preserves existing manual connection bindings byte for byte", () => {
    const app = { id: "manual", baseUrl: "http://127.0.0.1:8642", providerConfig: { profile: "existing" }, apiKeyEnc: "ciphertext" };
    expect(hermesTargetKey(app)).toBe(createHash("sha256").update(JSON.stringify([app.id, app.baseUrl, "existing", app.apiKeyEnc])).digest("hex"));
  });
  it("creates blank profiles, configures explicitly, and checks authenticated native readiness", async () => {
    const { mock, protocol } = fixture(); let attempted = false;
    await protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => { attempted = true; });
    expect(attempted).toBe(true);
    const create = mock.calls.find((c) => c.method === "POST")!;
    expect(create.path).toBe("/api/profiles");
    expect(create.body).toEqual({ name, description: "marker", clone_from: null, clone_from_default: false, clone_all: false, clone_channels: false, no_skills: true, provider: "openai", model: "mock-model", mcp_servers: [], keep_skills: [], hub_skills: [] });
    for (const call of mock.calls) {
      if (call.path.startsWith("/api/")) { expect(call.headers.get("X-Hermes-Session-Token")).toBe(secret.dashboardToken); expect(call.headers.has("Authorization")).toBe(false); }
      else { expect(call.path).toContain(`/p/${name}/v1/`); expect(call.headers.get("Authorization")).toBe(`Bearer ${secret.profileKeys[0]}`); }
    }
    expect(mock.calls.some((c) => c.path === "/api/config" && c.body.config)).toBe(true);
    const enabled = mock.calls.findIndex((c) => c.body.key === "API_SERVER_ENABLED");
    expect(enabled).toBeGreaterThan(mock.calls.findIndex((c) => c.path === "/api/config" && c.method === "PUT"));
    expect(mock.calls.findIndex((c) => c.body.key === "API_SERVER_KEY")).toBeGreaterThan(mock.calls.findIndex((c) => c.path === "/api/config" && c.method === "PUT"));
    expect(mock.calls.filter((c) => c.path === "/api/env").some((c) => c.body.value === secret.dashboardToken)).toBe(false);
  });
  it("uses the profile alias for Runs discovery and the native model for dashboard readback", async () => {
    const { protocol, mock } = fixture();
    await protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {});
    const t = protocol.target(name, 0);
    const models = await (await t.fetch!(`${connection.runsUrl}/p/${name}/v1/models`, { headers: { Authorization: `Bearer ${t.apiKey}` } })).json();
    expect(models.data[0].id).toBe(name);
    expect(models.data[0].id).not.toBe(config.model);
    mock.profiles.get(`19000:${name}`)!.model.default = "changed-native-model";
    await expect(protocol.verify(name, config, "Instructions", 0)).rejects.toThrow();
  });
  it("reconciles a lost create response with the same identity and never clones/deletes", async () => {
    const { mock, protocol } = fixture(); mock.loseCreateReply = true;
    await expect(protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {})).rejects.toThrow("setup is incomplete");
    await protocol.prepare(name, "marker", true, config, "Instructions", 0, async () => {});
    expect(mock.calls.filter((c) => c.path === "/api/profiles" && c.method === "POST")).toHaveLength(1);
    expect(mock.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("refuses existing profiles without its durable create intent and ownership marker", async () => {
    const { protocol } = fixture();
    await protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {});
    await expect(protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {})).rejects.toThrow("identity conflicts");
    await expect(protocol.prepare(name, "wrong-marker", true, config, "Instructions", 0, async () => {})).rejects.toThrow("identity conflicts");
  });
  it("repairs best-effort model failure through explicit config and readback", async () => {
    const { mock, protocol } = fixture(); mock.partialModel = true;
    await protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {});
    expect(mock.calls.some((c) => c.path.endsWith("/model") && c.method === "PUT")).toBe(true);
  });
  it.each(["ready", "wrongModel", "extraTools", "skills", "version", "authRequired"] as const)("fails closed for %s mismatch", async (kind) => {
    const { mock, protocol } = fixture();
    if (kind === "ready") mock.ready = false;
    else if (kind === "skills") mock.skills = [{ name: "unexpected" }];
    else if (kind === "version") mock.version = "other-version";
    else mock[kind] = true;
    await expect(protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {})).rejects.toThrow();
    expect(mock.calls.some((c) => c.path === "/v1/runs")).toBe(false);
  });
  it("blocks DNS/rebinding, metadata, redirects, path injection and default-profile requests", async () => {
    for (const url of ["http://localhost:19000", "http://169.254.169.254:19000", "http://127.0.0.1:19000/a", "http://user:pass@127.0.0.1:19000", "http://127.0.0.1:80", "http://127.0.0.1:19000?x=1", "http://2130706433:19000", "https://example.com"])
      expect(loopbackUrl.safeParse(url).success, url).toBe(false);
    const { protocol, mock } = fixture();
    expect(() => protocol.target("default", 0)).toThrow();
    await expect(protocol.target(name, 0).fetch!(connection.runsUrl + "/v1/runs")).rejects.toThrow();
    for (const path of ["../../../../v1/runs", "%2e%2e/%2e%2e/%2e%2e/v1/runs", "runs/%2F..%2F..%2Fstop", "runs?profile=default", "runs#fragment"])
      await expect(protocol.target(name, 0).fetch!(`${connection.runsUrl}/p/${name}/v1/${path}`)).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
    const input = { ...connection, ...secret, userId: "u", boundaryId: "runtime-u", provider: "openai", isolated: true };
    expect(connectionInput.safeParse(input).success).toBe(true);
    expect(connectionInput.safeParse({ ...input, profileKeys: [secret.profileKeys[0], secret.profileKeys[0]] }).success).toBe(false);
    expect(connectionInput.safeParse({ ...input, isolated: false }).success).toBe(false);
    expect(connectionInput.safeParse({ ...input, providerKey: input.dashboardToken }).success).toBe(false);
    expect(() => new ProfileProtocol(connection, { ...secret, providerKey: secret.dashboardToken }, mock.fetch)).toThrow();
  });
  it("redacts known credentials and suppresses raw errors in successful native JSON and chunked SSE", async () => {
    const json = new ProfileProtocol(connection, secret, async () => Response.json({ run_id: "run1", status: "failed", error: `Unrecognized credential ${secret.providerKey}`, output: secret.dashboardToken }));
    expect(await getRun(json.target(name, 0), "run1")).toMatchObject({ error: "Hermes could not complete the operation.", output: "[REDACTED]" });
    const payload = `id: 12\r\ndata: ${JSON.stringify({ event: "tool.completed", error: true, result: { key: secret.profileKeys[0], error: false } })}\r\n\r\nid: 13\ndata: ${JSON.stringify({ event: "run.failed", error: "unknown provider failure with secret text" })}\n\n`;
    const bytes = new TextEncoder().encode(payload);
    const sse = new ProfileProtocol(connection, secret, async () => new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); },
    }), { headers: { "Content-Type": "text/event-stream" } }));
    const events = [];
    for await (const event of runEvents(sse.target(name, 0), "run1")) events.push(event);
    expect(events).toEqual([
      { event: "tool.completed", error: true, result: { key: "[REDACTED]", error: false }, _seq: "12" },
      { event: "run.failed", error: "Hermes could not complete the operation.", _seq: "13" },
    ]);
  });
  it("bounds native successful JSON and SSE frames", async () => {
    for (const contentType of ["application/json", "text/event-stream"]) {
      const large = new ProfileProtocol(connection, secret, async () => new Response("x".repeat(300000), { headers: { "Content-Type": contentType } }));
      const read = async () => { const res = await large.target(name, 0).fetch!(`${connection.runsUrl}/p/${name}/v1/runs/run1/events`); await res.text(); };
      await expect(read()).rejects.toThrow("setup is incomplete");
    }
  });
  it("overlaps independent readiness reads after the health gate", async () => {
    const { protocol, mock } = fixture();
    await protocol.prepare(name, "marker", false, config, "Instructions", 0, async () => {});
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const paths: string[] = [];
    const parallel = new ProfileProtocol(connection, secret, async (...args: Parameters<typeof fetch>) => {
      const path = new URL(String(args[0])).pathname; paths.push(path);
      if (path !== "/api/health") await blocked;
      return mock.fetch(...args);
    });
    const pending = parallel.verify(name, config, "Instructions", 0);
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(paths).toHaveLength(7);
      expect(paths[0]).toBe("/api/health");
    } finally { release(); await pending; }
  });
  it("bounds remote response bodies and strips errors containing secrets", async () => {
    const { protocol, mock } = fixture(); mock.ready = false;
    const result = await protocol.target(name, 0).fetch!(`${connection.runsUrl}/p/${name}/v1/runs`);
    expect(await result.text()).toBe("{}");
    const large = new ProfileProtocol(connection, secret, async () => new Response("x".repeat(300000)));
    await expect(large.check()).rejects.toThrow("setup is incomplete");
  });
});
