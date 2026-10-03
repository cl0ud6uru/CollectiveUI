import { createServer } from "node:http";
import { ProvisioningMock } from "./provisioning-mock";

const mock = new ProvisioningMock();
for (const port of [19100, 19101, 19102, 19103]) {
  createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) { chunks.push(chunk); if (Buffer.concat(chunks).length > 100000) throw new Error("large request"); }
      const body = Buffer.concat(chunks).toString();
      if (req.url === "/__test" && port === 19100) {
        if (req.method === "POST") { const flags = JSON.parse(body); if (flags.reset === true) { mock.profiles.clear(); mock.calls.length = 0; } if (typeof flags.ready === "boolean") mock.ready = flags.ready; }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ profiles: mock.profiles.size, runs: mock.calls.filter((c) => c.path.endsWith("/v1/runs")).map((c) => ({ origin: c.origin, path: c.path, body: c.body })) })); return;
      }
      const response = await mock.fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch { res.writeHead(500); res.end("Synthetic service failure"); }
  }).listen(port, "127.0.0.1");
}
console.log("Synthetic Hermes management/Runs fixtures listening on 19100–19103");
