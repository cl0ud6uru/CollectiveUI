import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpEcho } from "./helpers/mock-llm";

// Integration: needs DATABASE_URL pointing at a migrated database. Skipped otherwise. Runs dev/mcp-echo.
const run = process.env.DATABASE_URL ? describe : describe.skip;

const SECRET = "it-identity-secret-0123456789abcdef";
const TOKEN = "it-static-bearer-key";

run("MCP servers against mcp-echo (integration)", () => {
  let echo: Awaited<ReturnType<typeof startMcpEcho>>;
  let serverId = "";
  const stats = async () => (await fetch(`${echo.base}/__mock/stats`)).json();
  const control = (path: string, body: object = {}) => fetch(`${echo.base}/__mock/${path}`, { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    const { db } = await import("@/db");
    const { mcpServers } = await import("@/db/schema");
    const { AAD, encrypt } = await import("@/lib/crypto");
    const { newId } = await import("@/lib/ids");
    const { sealIdentitySecret } = await import("@/lib/mcp/identity");
    // Requires the key and a valid identity for this audience, like a real server should.
    echo = await startMcpEcho((url) => ({ MCP_TOKEN: TOKEN, MCP_IDENTITY_SECRET: SECRET, MCP_REQUIRE_IDENTITY: "true", MCP_IDENTITY_AUDIENCE: url }));
    serverId = newId();
    await db.insert(mcpServers).values({
      id: serverId,
      name: `IT Echo ${Date.now()}`,
      url: echo.url,
      transport: "http",
      headersEnc: encrypt(JSON.stringify({ Authorization: `Bearer ${TOKEN}` }), AAD.mcpHeaders),
      identityHeader: "X-Portal-Identity",
      identitySecretEnc: sealIdentitySecret(serverId, SECRET),
      resultBudgetKb: 1,
    });
  });

  afterAll(async () => {
    const { db, pool } = await import("@/db");
    const { mcpServers } = await import("@/db/schema");
    if (serverId) await db.delete(mcpServers).where(eq(mcpServers.id, serverId));
    await pool.end();
    echo?.stop();
  });

  const load = async () => {
    const { db } = await import("@/db");
    const { mcpServers } = await import("@/db/schema");
    return (await db.select().from(mcpServers).where(eq(mcpServers.id, serverId)))[0];
  };

  it("Test captures the tool list as the portal itself, with the static key and a system identity", async () => {
    const { refreshMcpServer } = await import("@/lib/mcp/servers");
    const r = await refreshMcpServer(serverId);
    expect(r).toMatchObject({ ok: true, result: "captured" });
    const s = await load();
    expect(s.status).toBe("draft");
    expect(s.toolsSnapshot!.map((t) => t.name).sort()).toEqual(["delete_record", "echo", "get_time", "long_text", "lookup_employee", "whoami"]);
    expect(s.toolsSnapshot!.find((t) => t.name === "delete_record")!.annotations).toMatchObject({ destructiveHint: true });
    expect(s.toolsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.serverInfo).toMatchObject({ name: "portal-echo", version: "1.0.0" });
    expect(s.lastError).toBeNull();
    const st = await stats();
    expect(st.lastAuthorization).toBe(`Bearer ${TOKEN}`);
    expect(st.lastIdentity).toMatchObject({ sub: "portal:system", system: true, aud: echo.url, iss: "ai-portal" });
  });

  it("tools load without connecting; the first call connects and sends the person's identity", async () => {
    const { mcpTools } = await import("@/lib/agent/tools/mcp");
    await control("reset");
    const server = await load();
    const ts = mcpTools(server, {
      caller: { subject: { kind: "user", id: "u-it", upn: "alice@corp.local", email: null, name: "Alice", groups: ["Engineering"] }, botId: "b-it", conversationId: "c-it" },
      config: { tools: ["whoami", "long_text"] },
      taken: new Set(),
    });
    expect(ts.entries.map((e) => e.name).sort()).toEqual([expect.stringMatching(/__long_text$/), expect.stringMatching(/__whoami$/)]);
    expect((await stats()).requests).toBe(0); // a turn that calls no MCP tool opens no connection

    const whoami = ts.entries.find((e) => e.name.endsWith("__whoami"))!;
    const out = (await whoami.tool.execute!({}, { toolCallId: "t1", messages: [] } as never)) as { content: { text: string }[] };
    expect(JSON.parse(out.content[0].text)).toEqual({ upn: "alice@corp.local", name: "Alice", groups: ["Engineering"] });
    expect((await stats()).lastIdentity).toMatchObject({ sub: "u-it", bot: "b-it", conv: "c-it", aud: echo.url });

    // Long results are cut to the server's limit (1 KB here), and hidden characters are stripped.
    const long = ts.entries.find((e) => e.name.endsWith("__long_text"))!;
    const capped = (await long.tool.execute!({ size: 50_000 }, { toolCallId: "t2", messages: [] } as never)) as { content: { text: string }[] };
    expect(capped.content[0].text.startsWith("startx")).toBe(true);
    expect(capped.content[0].text).toHaveLength(1024);
    expect(capped.content[0].text).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
    expect(capped.content[1].text).toMatch(/Truncated/);
    const connections = (await stats()).requests;
    await ts.close();
    expect(connections).toBeGreaterThan(0);
  });

  it("a changed tool list waits for review: changed tools are hidden, new ones aren't offered", async () => {
    const { db } = await import("@/db");
    const { mcpServers } = await import("@/db/schema");
    const { acceptMcpDrift, offeredTools, refreshMcpServer } = await import("@/lib/mcp/servers");
    await db.update(mcpServers).set({ status: "enabled" }).where(eq(mcpServers.id, serverId));
    expect((await refreshMcpServer(serverId)).ok && "unchanged").toBe("unchanged");

    await control("tools", { variant: "changed" });
    const r = await refreshMcpServer(serverId);
    expect(r).toMatchObject({ ok: true, result: "drift", drift: { added: ["create_ticket"], changed: ["echo"], removed: [] } });
    let s = await load();
    expect(s.status).toBe("needs_review");
    expect(offeredTools(s).map((t) => t.name)).not.toContain("echo");
    expect(offeredTools(s).map((t) => t.name)).not.toContain("create_ticket");

    // Seeing it again keeps the first detection time; accepting needs the hash that was reviewed.
    const again = await refreshMcpServer(serverId);
    expect(again.ok && again.drift!.detectedAt).toBe(s.toolsDrift!.detectedAt);
    expect(await acceptMcpDrift(serverId, "stale")).toMatchObject({ ok: false });
    expect(await acceptMcpDrift(serverId, s.toolsDrift!.hash)).toEqual({ ok: true });
    s = await load();
    expect(s.status).toBe("enabled");
    expect(s.toolsDrift).toBeNull();
    expect(offeredTools(s).map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "create_ticket"]));

    // A change that goes away again clears itself.
    await control("tools", { variant: "default" });
    expect(await refreshMcpServer(serverId)).toMatchObject({ result: "drift" });
    await control("tools", { variant: "changed" });
    expect(await refreshMcpServer(serverId)).toMatchObject({ result: "resolved" });
    s = await load();
    expect(s.status).toBe("enabled");
    expect(s.toolsDrift).toBeNull();
  });

  it("an unreachable server is recorded without losing the accepted tools", async () => {
    const { db } = await import("@/db");
    const { mcpServers } = await import("@/db/schema");
    const { refreshMcpServer } = await import("@/lib/mcp/servers");
    await db.update(mcpServers).set({ headersEnc: null }).where(eq(mcpServers.id, serverId)); // no key → 401
    const r = await refreshMcpServer(serverId);
    expect(r.ok).toBe(false);
    const s = await load();
    expect(s.lastError).toBeTruthy();
    expect(s.lastError).not.toContain(TOKEN);
    expect(s.toolsSnapshot!.length).toBeGreaterThan(0);
    expect(s.status).toBe("enabled");
  });
});
