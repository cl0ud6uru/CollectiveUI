import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds nullable usage lifecycle evidence without relabeling historical counters or billing identities", async () => {
  const client = new PGlite();
  const folder = "src/db/migrations";
  const sql = (file: string) => readFileSync(`${folder}/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]");
  try {
    await client.waitReady;
    for (const file of readdirSync(folder).filter(file => file.endsWith(".sql") && file < "0070_").sort()) await client.exec(sql(file));
    await client.exec(`INSERT INTO usage_events(id,provider_kind,model,purpose,billing_source,input_tokens,billing_route)
      VALUES ('historical','hermes','unreported','chat','hermes',NULL,'unknown:hermes')`);
    const before = (await client.query("SELECT * FROM usage_events")).rows[0];
    await client.exec(sql("0070_usage_completion.sql"));
    const { completion_status, ...after } = (await client.query<Record<string, unknown>>("SELECT * FROM usage_events")).rows[0];
    expect(completion_status).toBeNull();
    expect(after).toEqual(before);
    for (const status of ["complete", "incomplete", "started"])
      await client.query("UPDATE usage_events SET completion_status = $1 WHERE id='historical'", [status]);
    await expect(client.exec("UPDATE usage_events SET completion_status='guessed' WHERE id='historical'")).rejects.toThrow();
    expect((await client.query("SELECT input_tokens, output_tokens, cost_micros, model, billing_route FROM usage_events")).rows).toEqual([
      { input_tokens: null, output_tokens: null, cost_micros: null, model: "unreported", billing_route: "unknown:hermes" },
    ]);
  } finally { await client.close(); }
}, 30_000);

it("chains snapshot 0070 after attachment migration 0069 with only the lifecycle column and check", () => {
  const before = JSON.parse(readFileSync("src/db/migrations/meta/0069_snapshot.json", "utf8"));
  const after = JSON.parse(readFileSync("src/db/migrations/meta/0070_snapshot.json", "utf8"));
  expect(after.prevId).toBe(before.id);
  expect(after.tables["public.usage_events"].columns.completion_status).toEqual({ name: "completion_status", type: "text", primaryKey: false, notNull: false });
  delete after.tables["public.usage_events"].columns.completion_status;
  delete after.tables["public.usage_events"].checkConstraints.usage_events_completion_status_check;
  delete after.id; delete after.prevId; delete before.id; delete before.prevId;
  expect(after).toEqual(before);
});
