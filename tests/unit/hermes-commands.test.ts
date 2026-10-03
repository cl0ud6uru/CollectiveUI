import { describe, expect, it, vi } from "vitest";
import { HERMES_COMMANDS, parseHermesInput, unsupportedHermesCommand } from "@/lib/chat/hermes-commands";
import { discoverHermes, startRun } from "@/lib/llm/providers/hermes/client";
import { allowedHermesModels, hermesTargetKey } from "@/lib/llm/providers/hermes/scope";

describe("Hermes command boundaries", () => {
  it.each(["/help", " /HELP \n", "/hermes help"])("recognizes %s as a local command", (input) => {
    expect(parseHermesInput(input)).toEqual({ kind: "command", namespace: "hermes", name: "help", args: "" });
  });
  it.each(["explain /help", "/tmp/file", "https://example.com", "some\n/help", "/", "code: `/reset`"])("leaves prose and paths alone: %s", (input) => {
    expect(parseHermesInput(input)).toEqual({ kind: "text", text: input, literal: false });
  });
  it("requires an explicit escape to send an unknown slash token as ordinary model text", () => {
    expect(parseHermesInput("/unknown arg")).toMatchObject({ kind: "command", name: "unknown", args: "arg" });
    expect(parseHermesInput("//unknown arg")).toEqual({ kind: "text", text: "/unknown arg", literal: true });
    expect(parseHermesInput("//hermes reset")).toMatchObject({ kind: "text", text: "/hermes reset" });
  });
  it("keeps namespaces explicit, including a portal skill named help", () => {
    expect(parseHermesInput("/portal help")).toMatchObject({ namespace: "portal", name: "help" });
    expect(parseHermesInput("/hermes model fast")).toMatchObject({ namespace: "hermes", name: "model", args: "fast" });
    expect(unsupportedHermesCommand("help", "portal")).toContain("Portal skills aren't available");
    expect(unsupportedHermesCommand("compress")).toContain("native Hermes session controls");
    expect(unsupportedHermesCommand("terminal")).toContain("cannot change the shared profile");
    expect(HERMES_COMMANDS.map((c) => c.name)).not.toContain("terminal");
  });
  it("binds run identities to app/profile/endpoint/credential, not display names or allowed route changes", () => {
    const app = { id: "a", baseUrl: "https://h.example", providerConfig: { profile: "alice", allowedModels: "fast,reasoning fast" }, apiKeyEnc: "sealed" };
    expect(allowedHermesModels(app)).toEqual(["fast", "reasoning"]);
    const key = hermesTargetKey(app);
    for (const change of [{ id: "b" }, { baseUrl: "https://other.example" }, { apiKeyEnc: "rotated" }, { providerConfig: { profile: "bob" } }])
      expect(hermesTargetKey({ ...app, ...change })).not.toBe(key);
    expect(hermesTargetKey({ ...app, providerConfig: { profile: "alice", allowedModels: "other" } })).toBe(key);
  });
});

describe("Hermes HTTP discovery", () => {
  const fixtures: Record<string, unknown> = {
    "/v1/models": { data: [{ id: "coder", api_key: "DO_NOT_EXPOSE" }, { id: "fast" }] },
    "/v1/skills": { data: [{ name: "help", description: "<script>not HTML</script>", instructions: "DO_NOT_EXPOSE" }] },
    "/v1/toolsets": { data: [{ name: "terminal", description: "Remote tools", enabled: true, configured: false, secret: "DO_NOT_EXPOSE" }] },
    "/v1/capabilities": { features: { run_stop: true }, endpoints: { evil: { path: "https://attacker.example" } } },
  };
  function target(overrides: Record<string, Response | unknown> = {}) {
    const calls: string[] = [];
    const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace("/p/alice", "");
      calls.push(path);
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
      const body = path in overrides ? overrides[path] : fixtures[path];
      return body instanceof Response ? body : Response.json(body);
    });
    return { t: { baseUrl: "http://127.0.0.1:8642", profile: "alice", apiKey: "test-key", fetch: fake as typeof fetch }, calls };
  }
  it("projects display metadata only and never follows discovered endpoints", async () => {
    const { t, calls } = target();
    const result = await discoverHermes(t);
    expect(result.models).toEqual({ available: true, items: ["coder", "fast"] });
    expect(result.skills).toEqual({ available: true, items: [{ name: "help", description: "<script>not HTML</script>" }] });
    expect(result.canStopRemotely).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_EXPOSE|test-key|attacker/);
    expect(calls.sort()).toEqual(Object.keys(fixtures).sort());
  });
  it.each([401, 404, 500])("isolates skills discovery failure (%s) from models and local capabilities", async (status) => {
    const { t } = target({ "/v1/skills": new Response("private server error/test-key", { status }) });
    const result = await discoverHermes(t);
    expect(result.skills.available).toBe(false);
    expect(result.models.available).toBe(true);
    expect(result.canStopRemotely).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private server error");
  });
  it("rejects malformed capabilities and bounds metadata before parsing", async () => {
    const { t } = target({ "/v1/capabilities": { features: { run_stop: "true" } }, "/v1/skills": new Response("x".repeat(256 * 1024 + 1)) });
    const result = await discoverHermes(t);
    expect(result.skills.available).toBe(false);
    expect(result.canStopRemotely).toBe(false);
    expect(result.capabilityWarning).toBeTruthy();
  });
  it("sends a scoped model request without changing the profile or adding provider credentials", async () => {
    let payload: unknown;
    const { t } = target();
    t.fetch = (async (_url, init) => { payload = JSON.parse(String(init?.body)); return Response.json({ run_id: "r" }); }) as typeof fetch;
    await startRun(t, { input: "hello", sessionId: "portal-one", idempotencyKey: "one", model: "fast" });
    expect(payload).toEqual({ input: "hello", session_id: "portal-one", model: "fast" });
    await startRun(t, { input: "hello", sessionId: "portal-two", idempotencyKey: "two" });
    expect(payload).toEqual({ input: "hello", session_id: "portal-two" });
  });
});
