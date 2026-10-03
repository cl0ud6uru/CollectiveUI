/** Synthetic transport only. No Hermes installation, profile filesystem or real credentials. */
export class ProvisioningMock {
  calls: { origin: string; path: string; method: string; body: Record<string, unknown>; headers: Headers }[] = [];
  profiles = new Map<string, { description: string; soul: string; model: { provider: string; default: string }; tools: string[]; env: Record<string, string> }>();
  ready = true;
  loseCreateReply = false;
  partialModel = false;
  wrongModel = false;
  version = "mock-pinned";
  skills: unknown[] = [];
  extraTools = false;
  authRequired = false;
  fetch: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const path = u.pathname, method = init?.method ?? "GET", headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.calls.push({ origin: u.origin, path: path + u.search, method, body, headers });
    if (path === "/api/health") return Response.json({ ok: true, version: this.version, displayVersion: this.version, auth_required: this.authRequired });
    // Paired ports: each synthetic user's dashboard and Runs origins share an in-memory runtime.
    const runtime = Number(u.port) % 2 === 0 ? Number(u.port) : Number(u.port) - 1;
    const prefix = `${runtime}:`;
    if (path === "/api/profiles" && method === "GET") return Response.json({ profiles: [...this.profiles].filter(([k]) => k.startsWith(prefix)).map(([k, p]) => ({ name: k.slice(prefix.length), description: p.description, is_default: false, model: p.model.default, provider: p.model.provider })) });
    if (path === "/api/profiles" && method === "POST") {
      if (this.profiles.has(prefix + body.name)) return Response.json({}, { status: 409 });
      this.profiles.set(prefix + body.name, { description: body.description, soul: "", model: { provider: body.provider, default: body.model }, tools: [], env: {} });
      if (this.loseCreateReply) { this.loseCreateReply = false; throw new Error("lost response contains mock-secret-never-display"); }
      return Response.json({ ok: true, name: body.name, model_set: !this.partialModel, model_error: this.partialModel ? "mock model error" : "", hub_installs: [] });
    }
    const name = body.profile ?? u.searchParams.get("profile") ?? /\/profiles\/([^/]+)/.exec(path)?.[1] ?? /\/p\/([^/]+)/.exec(path)?.[1];
    const p = this.profiles.get(prefix + name);
    if (!p) return Response.json({ error: "unknown profile" }, { status: 404 });
    if (path.startsWith("/p/")) {
      if (!this.ready) return Response.json({ secret: "mock-secret-never-display" }, { status: 503 });
      if (headers.get("authorization") !== `Bearer ${p.env.API_SERVER_KEY}`) return Response.json({}, { status: 401 });
      if (path.endsWith("/v1/capabilities")) return Response.json({ features: { run_submission: true, run_events_sse: true, run_stop: true, run_approval_response: true, approval_events: true } });
      // Pinned api_server._handle_models advertises the active profile alias, not its native model.
      if (path.endsWith("/v1/models")) return Response.json({ data: [{ id: this.wrongModel ? "wrong" : name, root: name, parent: null }] });
      if (path.endsWith("/v1/toolsets")) return Response.json({ data: [...p.tools, ...(this.extraTools ? ["terminal"] : [])].map((name) => ({ name, enabled: true, configured: true })) });
      if (path.endsWith("/v1/runs")) return Response.json({ run_id: "mock-run" });
      if (path.endsWith("/stop")) return Response.json({ status: "stopping" });
      if (path.endsWith("/approval")) return Response.json({ status: "resolved" });
      if (path.endsWith("/events")) return new Response('data: {"event":"message.delta","delta":"Mock profile reply"}\n\ndata: {"event":"run.completed","output":"Mock profile reply","usage":{"input_tokens":3,"output_tokens":4}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
      if (path.endsWith("/mock-run")) return Response.json({ run_id: "mock-run", status: "completed" });
    }
    if (path === "/api/env") { p.env[body.key] = body.value; return Response.json({ ok: true }); }
    if (path.endsWith("/model")) { p.model = { provider: body.provider, default: body.model }; return Response.json({ ok: true }); }
    if (path.endsWith("/soul")) { if (method === "PUT") p.soul = body.content; return Response.json({ ok: true, exists: true, content: p.soul }); }
    if (path === "/api/config") {
      if (method === "PUT") p.tools = body.config.platform_toolsets.api_server;
      return Response.json({ model: p.model.default, platform_toolsets: { api_server: p.tools, cli: [] }, skills: { external_dirs: [] }, mcp_servers: {}, approvals: { mode: "manual", timeout: 300 } });
    }
    if (path === "/api/skills") return Response.json(this.skills);
    throw new Error(`Unhandled synthetic request: ${method} ${path}`);
  };
}
