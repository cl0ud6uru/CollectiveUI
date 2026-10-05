import { test } from "node:test";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { watch, readFileSync } from "node:fs";
import { mkdtemp, stat, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostId, save, load } from "./storage.mjs";
test("host.json is valid JSON from the instant it becomes visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-host-visible-"));
  const errors = [];
  const watcher = watch(dir, (event, name) => {
    if (name === "host.json")
      try {
        JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch (e) {
        errors.push(e.message);
      }
  });
  try {
    await hostId(join(dir, "account.json"));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(errors, []);
  } finally {
    watcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("concurrent host initialization publishes one complete stable ID atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-host-race-"));
  try {
    const ids = await Promise.all(
      Array.from({ length: 30 }, () =>
        hostId(join(dir, "private", "account.json")),
      ),
    );
    assert.equal(new Set(ids).size, 1);
    assert.ok(ids[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("owner-only atomic storage and stable per-host identifier", async () => {
  const dir = await mkdtemp(join(tmpdir(), "plan-storage-"));
  try {
    const file = join(dir, "private", "account.json");
    const id = await hostId(file);
    assert.equal(await hostId(file), id);
    assert.match(id, /^urn:uuid:/);
    await save(file, { access_token: "fixture" });
    assert.deepEqual(await load(file), { access_token: "fixture" });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "private"))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
