import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { discovery, models, probe } from "./http.mjs";
test("SSE probe accepts split CRLF multiline completed event and exact marker", () =>
  fixture(
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const data = JSON.parse(body);
      assert.equal(data.store, false);
      assert.equal(data.stream, true);
      assert.equal(data.model, "supported");
      assert.ok(Array.isArray(data.input));
      assert.ok(data.instructions);
      res.setHeader("Content-Type", "text/event-stream");
      const text =
        'event: response.completed\r\ndata: {"type":"response.completed",\r\ndata: "response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"CHATGPT_PLAN_OK"}]}]}}\r\n\r\n';
      for (const c of text) {
        res.write(c);
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    },
    async (base) =>
      assert.equal(
        await probe(cred, "supported", { apiBase: base }),
        "CHATGPT_PLAN_OK",
      ),
  ));
for (const [name, data] of [
  ["failed", '{"type":"response.failed"}'],
  ["incomplete", '{"type":"response.incomplete"}'],
  [
    "partial",
    '{"type":"response.output_text.delta","delta":"CHATGPT_PLAN_OK"}',
  ],
  [
    "wrong marker",
    '{"type":"response.completed","response":{"status":"completed","output":[]}}',
  ],
])
  test(`SSE rejects ${name}`, () =>
    fixture(
      (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(`data: ${data}\n\n`);
      },
      (base) => assert.rejects(probe(cred, "supported", { apiBase: base })),
    ));
test("expired credentials never contact transport", () =>
  assert.rejects(
    models(
      { ...cred, expires_at: 0 },
      {
        fetch: () => {
          throw Error("must not fetch");
        },
      },
    ),
    /expired/,
  ));
test("provider errors are sanitized", () =>
  fixture(
    (req, res) => {
      res.writeHead(401);
      res.end("SECRET_TOKEN");
    },
    (base) =>
      assert.rejects(
        models(cred, { apiBase: base }),
        (e) => e.message === "Upstream HTTP 401",
      ),
  ));
test("body size and timeout are bounded", () =>
  fixture(
    (req, res) => {
      if (req.url === "/models")
        res.end(JSON.stringify({ models: [], padding: "x".repeat(100) }));
    },
    async (base) => {
      await assert.rejects(models(cred, { apiBase: base, maxBytes: 10 }));
      await assert.rejects(discovery({ issuerBase: base, timeoutMs: 30 }));
    },
  ));
export async function fixture(fn, run) {
  const server = createServer(fn);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
for (const [name, data] of [
  [
    "truncated after completion",
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"CHATGPT_PLAN_OK"}]}]}}\n\ndata: {"type":"response.failed"',
  ],
  [
    "unclosed completion",
    'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
  ],
])
  test(`SSE rejects ${name}`, () =>
    fixture(
      (req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.end(data);
      },
      (base) => assert.rejects(probe(cred, "supported", { apiBase: base })),
    ));
const cred = {
  access_token: "fixture",
  scopes: ["chatgpt.tokens.use.direct"],
  expires_at: Date.now() + 60000,
};
test("discovery and account-visible models use actual HTTP fixtures", () =>
  fixture(
    (req, res) => {
      if (req.url.includes("openid"))
        res.end(
          JSON.stringify({
            issuer: "https://auth.openai.com",
            jwks_uri: "https://auth.openai.com/jwks",
          }),
        );
      else {
        assert.equal(req.headers.authorization, "Bearer fixture");
        res.end(
          JSON.stringify({
            models: [
              {
                slug: "supported",
                display_name: "Supported",
                visibility: "list",
              },
              { slug: "hidden", visibility: "hidden" },
            ],
          }),
        );
      }
    },
    async (base) => {
      assert.equal(
        (await discovery({ issuerBase: base })).issuer,
        "https://auth.openai.com",
      );
      assert.deepEqual(await models(cred, { apiBase: base }), [
        { slug: "supported", display_name: "Supported" },
      ]);
    },
  ));
