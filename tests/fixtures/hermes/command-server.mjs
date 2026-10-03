/** Isolated HTTP fixture. No Hermes installation, shell, tools, model credentials or external requests. */
import { createServer } from "node:http";

export async function startCommandServer(port = 0) {
  const runs = new Map();
  const calls = [];
  let stopFails = false;
  let skillsFail = true; // Exercise the verified upstream discovery regression by default.
  const emit = (run, event) => {
    run.events.push(event);
    for (const res of run.listeners) res.write(`id: ${run.events.length}\ndata: ${JSON.stringify(event)}\n\n`);
    if (["run.completed", "run.cancelled"].includes(event.event)) {
      run.status = event.event === "run.completed" ? "completed" : "cancelled";
      for (const res of run.listeners) res.end();
      run.listeners.clear();
    }
  };
  const complete = (run) => {
    emit(run, { event: "message.delta", delta: "Mock Hermes reply" });
    emit(run, { event: "run.completed", output: "Mock Hermes reply", usage: { input_tokens: 12, output_tokens: 4 }, runtime: { provider: "mock", model: "actual-mock-model" } });
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const json = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try { body = JSON.parse(raw || "{}"); } catch { return json(400, {}); }
    }
    if (path === "/__test") {
      if (req.method === "POST") { stopFails = body.stopFails ?? false; skillsFail = body.skillsFail ?? true; }
      return json(200, { calls, runs: [...runs].map(([id, r]) => ({ id, body: r.body, status: r.status })) });
    }
    if (req.headers.authorization !== "Bearer isolated-hermes-key") return json(401, {});
    calls.push({ path, method: req.method, body: req.method === "POST" ? body : undefined });
    const route = path.replace(/^\/p\/mock/, "");
    if (route === "/health") return json(200, { version: "isolated-fixture" });
    if (route === "/v1/capabilities") return json(200, { features: { run_submission: true, run_events_sse: true, run_stop: true, run_approval_response: true, approval_events: true } });
    if (route === "/v1/models") return json(200, { data: [{ id: "coder" }, { id: "fast" }, { id: "reasoning" }, { id: "forbidden-route" }] });
    if (route === "/v1/skills") return skillsFail ? json(500, { error: "Isolated discovery failure" }) : json(200, { data: [{ name: "help", description: "Native skill that clashes with /help" }] });
    if (route === "/v1/toolsets") return json(200, { data: [{ name: "terminal", description: "Fixture metadata only", enabled: true, configured: true }] });
    if (route === "/v1/runs" && req.method === "POST") {
      const id = `run_mock${runs.size + 1}`;
      const run = { body, status: "running", events: [], listeners: new Set() };
      runs.set(id, run);
      json(202, { run_id: id });
      emit(run, { event: "run.started", run_id: id });
      if (String(body.input).includes("[approval]")) {
        emit(run, { event: "tool.started", tool: "terminal", call_id: "mock-call", args: { command: "mock-only" } });
        emit(run, { event: "approval.request", request_id: "mock-request", command: "mock-only", description: "Isolated approval fixture", tool: "terminal" });
      } else if (!String(body.input).includes("[slow]")) complete(run);
      return;
    }
    const match = /^\/v1\/runs\/([^/]+)(?:\/(events|approval|stop))?$/.exec(route);
    const run = match && runs.get(match[1]);
    if (!run) return json(404, {});
    if (match[2] === "events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
      const after = Number(req.headers["last-event-id"] ?? 0);
      run.events.forEach((event, index) => { if (index >= after) res.write(`id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`); });
      if (run.status !== "running") return res.end();
      run.listeners.add(res);
      res.on("close", () => run.listeners.delete(res));
      return;
    }
    if (match[2] === "stop") {
      if (stopFails) return json(503, {});
      if (run.status === "running") emit(run, { event: "run.cancelled" });
      return json(200, { status: run.status });
    }
    if (match[2] === "approval") { complete(run); return json(200, { resolved: 1 }); }
    return json(200, { run_id: match[1], status: run.status, output: "Mock Hermes reply" });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { for (const run of runs.values()) for (const res of run.listeners) res.end(); server.close(resolve); server.closeAllConnections(); }) };
}
