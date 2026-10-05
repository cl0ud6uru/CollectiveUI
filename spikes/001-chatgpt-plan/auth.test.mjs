import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "./auth.mjs";
import { load } from "./storage.mjs";
test("explicit auth listener loopback callback persists only validated result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-auth-"));
  try {
    const file = join(dir, "private", "account.json");
    let ready;
    const result = await auth(file, {
      onReady: async (a) => {
        ready = a;
        assert.equal(new URL(a.redirect).hostname, "127.0.0.1");
        assert.equal(new URL(a.redirect).pathname, "/auth/callback");
        const r = await fetch(
          `${a.redirect}?${new URLSearchParams({ state: a.state, code: "fixture", client_id: "issued" })}`,
        );
        assert.equal(r.status, 200);
      },
      exchange: async (a, q) => {
        assert.equal(q.get("code"), "fixture");
        return {
          client_id: "issued",
          subject: "fixture",
          ext_agent_host_id: a.host,
        };
      },
    });
    assert.equal(result.client_id, "issued");
    assert.deepEqual(await load(file), result);
    assert.ok(ready.host);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("denial closes listener and leaves active credentials untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-denial-"));
  try {
    const file = join(dir, "private", "account.json");
    await assert.rejects(
      auth(file, {
        onReady: (a) =>
          fetch(
            `${a.redirect}?${new URLSearchParams({ state: a.state, error: "access_denied" })}`,
          ),
      }),
      /denied/,
    );
    assert.equal(await load(file), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("auth listener timeout is bounded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-timeout-"));
  try {
    await assert.rejects(
      auth(join(dir, "private", "account.json"), {
        timeoutMs: 30,
        onReady: () => {},
      }),
      /expired/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
