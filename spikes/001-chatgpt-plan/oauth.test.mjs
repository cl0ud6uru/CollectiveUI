import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attempt, consume, exchange } from "./oauth.mjs";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createServer } from "node:http";
import { once } from "node:events";
import { auth } from "./auth.mjs";
import { load } from "./storage.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
test("complete loopback OAuth fixture validates JWT before saving and reauthorizes same subject", () =>
  identityFixture(async (f) => {
    const dir = await mkdtemp(join(tmpdir(), "plan-integrated-"));
    try {
      const file = join(dir, "private", "account.json");
      for (let i = 0; i < 2; i++) {
        const result = await auth(file, {
          issuerBase: f.base,
          tokenEndpoint: `${f.base}/token`,
          onReady: async (a) => {
            await f.sign(a);
            const params = new URLSearchParams({
              state: a.state,
              code: "fixture",
            });
            if (i === 0) params.set("client_id", "issued");
            const r = await fetch(`${a.redirect}?${params}`);
            assert.equal(r.status, 200);
            assert.ok(!a.url.includes("id_token_hint"));
          },
        });
        assert.equal(result.subject, "subject");
        assert.equal((await load(file)).access_token, "ACCESS_FIXTURE");
      }
      const previous = await load(file);
      await assert.rejects(
        auth(file, {
          issuerBase: f.base,
          tokenEndpoint: `${f.base}/token`,
          onReady: async (a) => {
            await f.sign(a, { sub: "other" });
            const r = await fetch(
              `${a.redirect}?${new URLSearchParams({ state: a.state, code: "fixture" })}`,
            );
            assert.equal(r.status, 400);
          },
        }),
      );
      assert.deepEqual(await load(file), previous);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }));
async function identityFixture(run) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "fixture";
  let body,
    token,
    scope = "chatgpt.tokens.use.direct";
  const server = createServer(async (req, res) => {
    if (req.url.includes("openid"))
      res.end(
        JSON.stringify({
          issuer: "https://auth.openai.com",
          jwks_uri: `http://127.0.0.1:${server.address().port}/jwks`,
        }),
      );
    else if (req.url === "/jwks") res.end(JSON.stringify({ keys: [jwk] }));
    else {
      body = "";
      for await (const chunk of req) body += chunk;
      res.end(
        JSON.stringify({
          id_token: token,
          access_token: "ACCESS_FIXTURE",
          refresh_token: "REFRESH_FIXTURE",
          token_type: "Bearer",
          expires_in: 3600,
          scope,
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({
      base,
      body: () => new URLSearchParams(body),
      setScope: (v) => (scope = v),
      sign: async (a, overrides = {}) => {
        token = await new SignJWT({ nonce: a.nonce, ...overrides })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(overrides.iss ?? "https://auth.openai.com")
          .setAudience(overrides.aud ?? "issued")
          .setSubject(overrides.sub ?? "subject")
          .setExpirationTime(overrides.exp ?? "5m")
          .sign(privateKey);
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
test("code exchange verifies signature discovery audience nonce and stores granted scopes", () =>
  identityFixture(async (f) => {
    const a = attempt({
      host: "host",
      redirect: "http://127.0.0.1:123/auth/callback",
    });
    await f.sign(a);
    const c = await exchange(
      a,
      new URLSearchParams({
        state: a.state,
        code: "code",
        client_id: "issued",
      }),
      { issuerBase: f.base, tokenEndpoint: `${f.base}/token` },
    );
    assert.equal(c.subject, "subject");
    assert.equal(c.client_id, "issued");
    assert.equal(c.access_token, "ACCESS_FIXTURE");
    assert.equal(f.body().get("redirect_uri"), a.redirect);
    assert.equal(f.body().get("resource"), "https://api.openai.com/v1");
    assert.equal(f.body().get("code_verifier"), a.verifier);
    assert.equal(f.body().get("client_id"), "issued");
    assert.ok(c.expires_at > Date.now());
  }));
for (const [name, overrides] of [
  ["nonce", { nonce: "wrong" }],
  ["issuer", { iss: "https://evil.example" }],
  ["audience", { aud: "wrong" }],
  ["expiry", { exp: 1 }],
  ["subject", { sub: "wrong" }],
])
  test(`ID token rejects ${name}`, () =>
    identityFixture(async (f) => {
      const a = attempt({
        host: "host",
        redirect: "http://127.0.0.1:123/auth/callback",
        saved: { client_id: "issued", subject: "subject" },
      });
      await f.sign(a, overrides);
      await assert.rejects(
        exchange(a, new URLSearchParams({ state: a.state, code: "code" }), {
          issuerBase: f.base,
          tokenEndpoint: `${f.base}/token`,
        }),
      );
    }));
test("token granted scope required regardless of callback scope", () =>
  identityFixture(async (f) => {
    const a = attempt({
      host: "host",
      redirect: "http://127.0.0.1:123/auth/callback",
    });
    await f.sign(a);
    f.setScope("openid");
    await assert.rejects(
      exchange(
        a,
        new URLSearchParams({
          state: a.state,
          code: "code",
          client_id: "issued",
          scope: "chatgpt.tokens.use.direct",
        }),
        { issuerBase: f.base, tokenEndpoint: `${f.base}/token` },
      ),
      /permission/,
    );
  }));
test("fresh PKCE state nonce and initial/returning authorization parameters", () => {
  const a = attempt({
    host: "urn:uuid:fixture",
    redirect: "http://127.0.0.1:12345/auth/callback",
  });
  const u = new URL(a.url);
  assert.equal(u.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(u.searchParams.get("agent_name_hint"), "CollectiveUI");
  assert.equal(
    u.searchParams.get("code_challenge"),
    createHash("sha256").update(a.verifier).digest("base64url"),
  );
  assert.equal(
    u.searchParams.get("scope"),
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  );
  assert.notEqual(
    a.state,
    attempt({ host: "fixture", redirect: a.redirect }).state,
  );
  const b = attempt({
    host: "fixture",
    redirect: a.redirect,
    saved: { client_id: "issued", subject: "sub", id_token: "hint" },
  });
  assert.equal(new URL(b.url).searchParams.get("agent_name_hint"), null);
  assert.equal(new URL(b.url).searchParams.get("client_id"), "issued");
});
test("callback atomically consumed and issued ID required before exchange", () => {
  const a = attempt({
    host: "fixture",
    redirect: "http://127.0.0.1:1/auth/callback",
  });
  assert.throws(() => consume(a, new URLSearchParams("code=c")), /state/);
  assert.throws(
    () => consume(a, new URLSearchParams(`state=${a.state}&code=c`)),
    /issued/,
  );
  const b = attempt({ host: "fixture", redirect: a.redirect });
  assert.equal(
    consume(
      b,
      new URLSearchParams({ state: b.state, code: "c", client_id: "issued" }),
    ).client_id,
    "issued",
  );
  assert.throws(
    () =>
      consume(
        b,
        new URLSearchParams({ state: b.state, code: "c", client_id: "issued" }),
      ),
    /consumed/,
  );
});
test("empty supplied returning client ID is rejected rather than normalized", () => {
  const a = attempt({
    host: "fixture",
    redirect: "http://127.0.0.1:1/auth/callback",
    saved: { client_id: "issued", subject: "subject" },
  });
  assert.throws(
    () =>
      consume(
        a,
        new URLSearchParams({ state: a.state, code: "fixture", client_id: "" }),
      ),
    /mismatch/,
  );
});
test("expired, denial, dynamic and mismatched returning IDs rejected", () => {
  for (const kind of ["expired", "denial", "dynamic", "mismatch"]) {
    const a = attempt({
      host: "fixture",
      redirect: "http://127.0.0.1:1/auth/callback",
      saved: kind === "mismatch" ? { client_id: "issued" } : null,
    });
    if (kind === "expired") a.deadline = 0;
    const q = new URLSearchParams({
      state: a.state,
      code: "c",
      client_id: kind === "dynamic" ? "dynamic_agent_client" : "other",
    });
    if (kind === "denial") q.set("error", "access_denied");
    assert.throws(() => consume(a, q));
    assert.equal(a.consumed, true);
  }
});
