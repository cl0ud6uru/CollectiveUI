import { readFileSync } from "node:fs";
import { PGlite, type QueryOptions, type Results, type Transaction } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

const folder = "src/db/migrations";
const snapshot = (index: number) => JSON.parse(readFileSync(`${folder}/meta/${String(index).padStart(4, "0")}_snapshot.json`, "utf8"));
async function environment() {
  const client = new PGlite();
  await client.waitReady;
  const transaction = client.transaction.bind(client);
  client.transaction = <T>(callback: (tx: Transaction) => Promise<T>) => transaction(async tx => {
    const prepared = tx.query.bind(tx);
    tx.query = async <T>(sql: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> => {
      if (params?.length) return prepared<T>(sql, params, options);
      return ((await tx.exec(sql, options)).at(-1) ?? { rows: [], fields: [], affectedRows: 0 }) as Results<T>;
    };
    return callback(tx);
  });
  const database = drizzle(client, { schema: {} });
  const migrations = readMigrationFiles({ migrationsFolder: folder });
  return { client, apply: (through = 51) => new PgDialect().migrate(migrations.slice(0, through + 1).map(migration => ({
    ...migration, sql: migration.sql.map(sql => sql.replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]")),
  })), database._.session, { migrationsFolder: folder }) };
}

describe("compatible saved-provider additive upgrade (synthetic PGlite, no pgvector)", () => {
  it("changes only the two provider constraints and adds a compatible destination check", () => {
    const prior = snapshot(50), next = snapshot(51);
    expect(next.prevId).toBe(prior.id);
    for (const [name, table] of Object.entries(prior.tables)) {
      const expected = structuredClone(next.tables[name]);
      if (name === "public.ai_apps") expected.checkConstraints.ai_apps_provider_connection_check = prior.tables[name].checkConstraints.ai_apps_provider_connection_check;
      if (name === "public.provider_connections") {
        expected.checkConstraints.provider_connections_provider_check = prior.tables[name].checkConstraints.provider_connections_provider_check;
        delete expected.checkConstraints.provider_connections_compatible_target_check;
      }
      expect(expected, name).toEqual(table);
    }
    expect(Object.keys(next.tables)).toEqual(Object.keys(prior.tables));
    const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8"));
    expect(journal.entries[51]).toMatchObject({ idx: 51, tag: "0051_saved_compatible_provider_connections" });
    expect(journal.entries.map((entry: { idx: number }) => entry.idx)).toEqual(journal.entries.map((_: unknown, index: number) => index));
    expect(journal.entries[51].when).toBeGreaterThan(journal.entries[50].when);
  });

  it.each(["fresh", "existing"])("preserves %s rows and replays the migration history idempotently", async source => {
    const env = await environment();
    try {
      await env.apply(50);
      if (source === "existing") await env.client.exec(`
        INSERT INTO users(id,upn,name,auth_source) VALUES ('owner','owner@fixture.invalid','Synthetic owner','ldap');
        INSERT INTO groups(id,name) VALUES ('audience','Synthetic audience');
        INSERT INTO provider_connections(id,name,base_url,secret_enc,organization,project,created_by)
          VALUES ('saved','Retained saved API','https://provider.example/v1','opaque-retained-ciphertext','org-fixture','project-fixture','owner'),
            ('malformed','Retained malformed endpoint','https://provider.example/v1/chat/completions','opaque-malformed-ciphertext',null,null,'owner');
        INSERT INTO ai_apps(id,name,provider,model,provider_connection_id,is_public)
          VALUES ('linked','Retained model','openai','fixture/model','saved',false);
        INSERT INTO ai_apps(id,name,provider,model,base_url,api_key_enc,is_public)
          VALUES ('legacy','Retained legacy','openai-compatible','fixture/model','https://other.example/api/v1/','opaque-legacy-ciphertext',false);
        INSERT INTO app_access(app_id,group_id) VALUES ('linked','audience'),('legacy','audience');
        INSERT INTO bots(id,owner_id,name,app_id) VALUES ('bot','owner','Retained bot','linked');
        INSERT INTO conversations(id,user_id,bot_id,app_id,title) VALUES ('chat','owner','bot','linked','Retained synthetic history');
        INSERT INTO messages(id,conversation_id,role,parts) VALUES ('message','chat','user','[{"type":"text","text":"Synthetic retained message"}]');
      `);
      const tables = ["users", "groups", "provider_connections", "ai_apps", "app_access", "bots", "conversations", "messages"];
      const before = await Promise.all(tables.map(table => env.client.query(`SELECT * FROM ${table} ORDER BY 1`)));
      await env.apply();
      await env.apply();
      for (const [index, table] of tables.entries()) expect((await env.client.query(`SELECT * FROM ${table} ORDER BY 1`)).rows, table).toEqual(before[index].rows);
      expect((await env.client.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(52);
      await env.client.exec(`INSERT INTO provider_connections(id,name,provider,base_url,secret_enc) VALUES ('compatible','New synthetic API','openai-compatible','https://provider.example/api/v1','opaque-synthetic-ciphertext');
        INSERT INTO ai_apps(id,name,provider,model,base_url,provider_connection_id) VALUES ('compatible-model','Compatible synthetic model','openai-compatible','fixture/model','https://provider.example/api/v1','compatible');`);
      for (const sql of [
        "INSERT INTO provider_connections(id,name,provider,secret_enc) VALUES ('no-base','Invalid','openai-compatible','opaque')",
        "INSERT INTO provider_connections(id,name,provider,base_url,organization,secret_enc) VALUES ('billing','Invalid','openai-compatible','https://provider.example/v1','org','opaque')",
        "INSERT INTO provider_connections(id,name,provider,secret_enc) VALUES ('personal','Invalid','chatgpt','opaque')",
        "UPDATE ai_apps SET api_key_enc='opaque-injected' WHERE id='compatible-model'",
        "UPDATE ai_apps SET credential_mode='user' WHERE id='compatible-model'",
        "UPDATE ai_apps SET provider='chatgpt',credential_mode='user' WHERE id='compatible-model'",
        "DELETE FROM provider_connections WHERE id='compatible'",
      ]) await expect(env.client.exec(sql)).rejects.toThrow();
    } finally { await env.client.close(); }
  }, 60000);
});
