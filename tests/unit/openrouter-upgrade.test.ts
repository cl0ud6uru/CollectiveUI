import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds OpenRouter without rewriting existing provider credentials, destinations, models or audiences", async () => {
  const client = new PGlite();
  const folder = "src/db/migrations";
  const sql = (file: string) => readFileSync(`${folder}/${file}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]");
  try {
    await client.waitReady;
    for (const file of readdirSync(folder).filter(f => f.endsWith(".sql") && f < "0058_").sort()) await client.exec(sql(file));
    await client.exec(`INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES ('admin','admin@fixture.invalid','Synthetic admin','local','local');
      INSERT INTO groups(id,name) VALUES ('audience','Synthetic audience');
      INSERT INTO provider_connections(id,name,provider,base_url,secret_enc) VALUES
        ('legacy','Retained OpenRouter mistake','openai','https://openrouter.ai/api/v1/chat/completions','opaque-retained-ciphertext'),
        ('generic','Retained generic API','openai-compatible','https://custom.example/api/v1','opaque-generic-ciphertext');
      INSERT INTO ai_apps(id,name,provider,model,base_url,provider_connection_id,is_public) VALUES
        ('model','Retained model','openai-compatible','fixture/model','https://custom.example/api/v1','generic',false);
      INSERT INTO app_access(app_id,group_id) VALUES ('model','audience');`);
    const tables = ["provider_connections", "ai_apps", "app_access"];
    const before = await Promise.all(tables.map(t => client.query(`SELECT * FROM ${t} ORDER BY 1`)));
    await client.exec(sql("0058_openrouter_models.sql"));
    for (const [i, table] of tables.entries()) expect((await client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows).toEqual(before[i].rows);
    await client.exec(`INSERT INTO provider_connections(id,name,provider,base_url,secret_enc) VALUES ('router','OpenRouter','openrouter','https://openrouter.ai/api/v1','opaque-fixture');
      INSERT INTO ai_apps(id,name,provider,model,base_url,provider_connection_id) VALUES ('router-model','OpenRouter model','openrouter','vendor/model','https://openrouter.ai/api/v1','router');`);
    for (const target of ["https://other.example/v1", "https://openrouter.ai/api/v1/chat/completions"]) {
      await expect(client.query("INSERT INTO provider_connections(id,name,provider,base_url,secret_enc) VALUES ('bad','Bad','openrouter',$1,'opaque-fixture')", [target])).rejects.toThrow();
    }
    const prior = JSON.parse(readFileSync(`${folder}/meta/0057_snapshot.json`, "utf8"));
    const next = JSON.parse(readFileSync(`${folder}/meta/0058_snapshot.json`, "utf8"));
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8"));
    expect(journal.entries[58]).toMatchObject({ idx: 58, tag: "0058_openrouter_models" });
    expect(journal.entries.filter((entry: { tag: string }) => entry.tag === "0058_openrouter_models")).toHaveLength(1);
    expect(journal.entries[58].when).toBeGreaterThan(journal.entries[57].when);
    expect(journal.entries.map((entry: { idx: number }) => entry.idx)).toEqual(journal.entries.map((_: unknown, index: number) => index));
    expect(next.prevId).toBe(prior.id);
    for (const name of Object.keys(prior.tables)) {
      const a = structuredClone(prior.tables[name]), b = structuredClone(next.tables[name]);
      if (name === "public.ai_apps" || name === "public.provider_connections") { delete a.checkConstraints; delete b.checkConstraints; }
      expect(b, name).toEqual(a);
    }
    expect(Object.keys(next.tables)).toEqual(Object.keys(prior.tables));
  } finally { await client.close(); }
}, 30_000);
