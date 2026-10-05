import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { main } from "./cli.mjs";
test("help is runnable without credentials or side effects", () => {
  const r = spawnSync(process.execPath, ["cli.mjs", "--help"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /auth/);
  assert.match(r.stdout, /discover/);
  assert.match(r.stdout, /--credential-file/);
});
test("SSH tunnel target rejects shell expansion and option injection before auth", async () => {
  for (const target of ["$(touch /tmp/no)", "-oProxyCommand=sh", "host;false"])
    await assert.rejects(
      main(["auth", `--ssh-target=${target}`], {
        auth: async () => {},
        out: () => {},
      }),
      /SSH target/,
    );
});
test("discover CLI prints only public metadata", async () => {
  const lines = [];
  await main(["discover"], {
    out: (x) => lines.push(x),
    discovery: async () => ({
      issuer: "https://auth.openai.com",
      jwks_uri: "https://auth.openai.com/jwks",
      other: "not printed",
    }),
  });
  assert.deepEqual(JSON.parse(lines[0]), {
    issuer: "https://auth.openai.com",
    jwks_uri: "https://auth.openai.com/jwks",
  });
});
test("unknown commands options and checkout credential paths rejected", async () => {
  for (const args of [
    ["wat"],
    ["models", "--wat"],
    ["auth", "--credential-file", "./credentials.json"],
    ["auth", "--port", "99999"],
  ])
    await assert.rejects(main(args, { out: () => {} }));
});
test("models and probe CLI never print credential material", async () => {
  const lines = [];
  const deps = {
    out: (x) => lines.push(x),
    load: async () => ({ access_token: "SECRET" }),
    models: async () => [{ slug: "fixture", display_name: "Fixture" }],
    probe: async () => "CHATGPT_PLAN_OK",
  };
  await main(["models"], deps);
  await main(["probe", "--model", "fixture"], deps);
  assert.equal(lines[1], "CHATGPT_PLAN_OK");
  assert.ok(!lines.join("").includes("SECRET"));
  await assert.rejects(main(["probe", "--model", "unknown"], deps), /visible/);
});
