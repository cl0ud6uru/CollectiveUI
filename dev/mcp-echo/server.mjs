// Minimal MCP server (Streamable HTTP, stateless) for local testing of the MCP integration.
// Tools: echo, get_time, lookup_employee (fake directory), whoami (portal identity), delete_record (destructive),
// long_text (a long result with hidden characters, for the portal's result limit and cleaning).
//
// Optional auth:
//   MCP_TOKEN=<token>               require "Authorization: Bearer <token>" (a static key, like most internal MCP apps)
//   MCP_IDENTITY_SECRET=<secret>    verify the portal's signed per-user identity header (HS256 JWT, 60 s lifetime)
//   MCP_IDENTITY_HEADER=<name>      header carrying it (default X-Portal-Identity)
//   MCP_IDENTITY_AUDIENCE=<url>     also require the token's aud to be this URL (what a real server should do)
//   MCP_REQUIRE_IDENTITY=true       reject calls without a valid identity (otherwise whoami just reports "anonymous")
//
// Test controls (dev only): POST /__mock/tools {"variant":"changed"} changes echo's description and adds
// create_ticket (drift); {"variant":"default"} restores. GET /__mock/stats returns request counts and the last
// verified identity; POST /__mock/reset clears them.
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 4020);
const TOKEN = process.env.MCP_TOKEN; // optional: require "Authorization: Bearer <token>"
const IDENTITY_SECRET = process.env.MCP_IDENTITY_SECRET;
const IDENTITY_HEADER = (process.env.MCP_IDENTITY_HEADER ?? "X-Portal-Identity").toLowerCase();
const REQUIRE_IDENTITY = process.env.MCP_REQUIRE_IDENTITY === "true";
const IDENTITY_AUDIENCE = process.env.MCP_IDENTITY_AUDIENCE;

let variant = "default";
const stats = { requests: 0, toolCalls: 0, lastIdentity: null, lastAuthorization: null };

/** Verifies an HS256 JWT. Returns its claims, or null when it is missing, forged or expired. */
function verifyIdentity(token) {
  if (!IDENTITY_SECRET || !token) return null;
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) return null;
  const expected = createHmac("sha256", IDENTITY_SECRET).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  if (header.alg !== "HS256") return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
  if (IDENTITY_AUDIENCE && claims.aud !== IDENTITY_AUDIENCE) return null;
  return claims;
}

const EMPLOYEES = [
  { name: "Alice Admin", title: "Head of Platform", team: "Platform", email: "alice@corp.local" },
  { name: "Bob Builder", title: "Senior Engineer", team: "Payments", email: "bob@corp.local" },
  { name: "Carol Contractor", title: "Designer", team: "Brand", email: "carol@corp.local" },
];

function buildServer(identity) {
  const server = new McpServer({ name: "portal-echo", version: "1.0.0" });
  server.registerTool(
    "echo",
    {
      description: variant === "changed" ? "Echo back the given text, loudly" : "Echo back the given text",
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "get_time",
    { description: "Current server time (ISO 8601)", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }),
  );
  server.registerTool(
    "lookup_employee",
    {
      description: "Look up an employee in the company directory by name or team",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const q = query.toLowerCase();
      const hits = EMPLOYEES.filter((e) => e.name.toLowerCase().includes(q) || e.team.toLowerCase().includes(q));
      return { content: [{ type: "text", text: JSON.stringify(hits) }] };
    },
  );
  server.registerTool(
    "whoami",
    { description: "Report which portal user is calling (from the signed identity header)", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(identity ? { upn: identity.upn, name: identity.name, groups: identity.groups ?? [] } : { anonymous: true }) }],
    }),
  );
  server.registerTool(
    "delete_record",
    {
      description: "Delete a record by id (fake; nothing is actually deleted)",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => ({ content: [{ type: "text", text: `deleted record ${id}` }] }),
  );
  server.registerTool(
    "long_text",
    { description: "Return a long text of the given size", inputSchema: { size: z.number().int().min(1).max(1_000_000) }, annotations: { readOnlyHint: true } },
    // Includes invisible Unicode tag characters ("hidden" in ASCII smuggling), which the portal strips.
    async ({ size }) => ({ content: [{ type: "text", text: `start\u{E0068}\u{E0069}${"x".repeat(Math.max(0, size - 5))}` }] }),
  );
  if (variant === "changed") {
    server.registerTool(
      "create_ticket",
      { description: "Create a ticket", inputSchema: { title: z.string() }, annotations: { readOnlyHint: false } },
      async ({ title }) => ({ content: [{ type: "text", text: `created ticket "${title}"` }] }),
    );
  }
  return server;
}

async function mockControl(req, res) {
  const send = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (req.method === "GET" && req.url === "/__mock/stats") return send(200, stats);
  if (req.method !== "POST") return send(405, { error: "method not allowed" });
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url === "/__mock/reset") {
    Object.assign(stats, { requests: 0, toolCalls: 0, lastIdentity: null, lastAuthorization: null });
    variant = "default";
    return send(200, { ok: true });
  }
  if (req.url === "/__mock/tools") {
    variant = JSON.parse(raw || "{}").variant === "changed" ? "changed" : "default";
    return send(200, { variant });
  }
  return send(404, { error: "not found" });
}

http
  .createServer(async (req, res) => {
    if (req.url?.startsWith("/__mock/")) return mockControl(req, res);
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end("unauthorized");
      return;
    }
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    let body;
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      body = raw ? JSON.parse(raw) : undefined;
    }
    const identity = verifyIdentity(req.headers[IDENTITY_HEADER]);
    stats.requests++;
    if (body?.method === "tools/call") stats.toolCalls++;
    if (identity) stats.lastIdentity = identity;
    stats.lastAuthorization = req.headers.authorization ?? null;
    if (REQUIRE_IDENTITY && !identity) {
      res.writeHead(401).end("missing or invalid identity");
      return;
    }
    const server = buildServer(identity);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  })
  .listen(PORT, () => console.log(`mcp-echo listening on http://localhost:${PORT}/mcp`));
