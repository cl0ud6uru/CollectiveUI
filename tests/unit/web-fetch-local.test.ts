import { createServer } from "node:http";
import { expect, it } from "vitest";
import { webTools } from "@/lib/agent/tools/web";
import type { AgentCtx } from "@/lib/agent/types";

it("fetches explicitly allowlisted local fixtures with the original Host, redirects and bounded text", async () => {
  const hosts: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    hosts.push(req.headers.host);
    if (req.url === "/start") { res.writeHead(302, { location: "/page" }); res.end(); }
    else if (req.url === "/bad-status") { res.writeHead(600); res.end(); }
    else { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Fixture</title><p>Approved test page</p>"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const entry = webTools({ toolSettings: { fetchAllowlist: ["localhost"] } } as unknown as AgentCtx).fetch_url;
    const call = (path: string) => Promise.resolve(entry.tool.execute!({ url: `http://localhost:${port}${path}` }, { toolCallId: "t", messages: [], context: undefined }));
    expect(await call("/start")).toMatchObject({ title: "Fixture", content: expect.stringContaining("Approved test page"), url: `http://localhost:${port}/page` });
    expect(hosts).toEqual([`localhost:${port}`, `localhost:${port}`]);
    await expect(call("/bad-status")).rejects.toThrow("Invalid HTTP response status");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
