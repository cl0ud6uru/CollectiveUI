import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const suite = process.env.PROVIDER_UPGRADE_TEST === "1" ? describe : describe.skip;
suite("saved provider migration lineage", () => {
  it.each(["fresh", "existing"])("preserves %s installation and replays idempotently", async (source) => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_provider_upgrade_test") throw new Error("Disposable provider upgrade DB required");
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "provider-upgrade-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      const previous = JSON.parse(await readFile(path.join(original, "meta/0022_snapshot.json"), "utf8"));
      const current = JSON.parse(await readFile(path.join(original, "meta/0023_snapshot.json"), "utf8"));
      expect(current.prevId).toBe(previous.id);
      expect(journal.entries.map((e: { idx: number }) => e.idx)).toEqual(Array.from({ length: journal.entries.length }, (_, i) => i));
      for (let i = 1; i < journal.entries.length; i++) expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
      const database = drizzle(pool);
      if (source === "existing") {
        const entries = journal.entries.filter((e: { idx: number }) => e.idx <= 22);
        await mkdir(path.join(folder, "meta"));
        for (const e of entries) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        await migrate(database, { migrationsFolder: folder });
        await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('owner','owner@fixture.invalid','Owner','ldap')");
        await pool.query("INSERT INTO groups(id,name) VALUES ('team','Team')");
        await pool.query("INSERT INTO ai_apps(id,name,provider,model,api_key_enc,provider_config,is_public) VALUES ('first','First','openai','one','opaque-first','{\"project\":\"first-project\"}',false),('second','Second','openai','two','opaque-second','{\"project\":\"second-project\"}',true)");
        await pool.query("INSERT INTO app_access(app_id,group_id) VALUES ('first','team')");
        await pool.query("INSERT INTO ai_apps(id,name,provider,model,credential_mode) VALUES ('personal','Personal','chatgpt','plan-model','user')");
        await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url,api_key_enc) VALUES ('hermes','Hermes','hermes','profile','http://127.0.0.1:1','opaque-hermes')");
        await pool.query("INSERT INTO bots(id,owner_id,name,app_id) VALUES ('bot','owner','Existing bot','first')");
      }
      const tables = ["users", "groups", "ai_apps", "app_access", "bots"];
      const before = source === "existing" ? await Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`))) : [];
      await migrate(database, { migrationsFolder: original });
      await migrate(database, { migrationsFolder: original });
      if (source === "existing") for (let i = 0; i < tables.length; i++) expect((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows).toMatchObject(before[i].rows);
      expect((await pool.query("SELECT id FROM provider_connections")).rows).toEqual([]);
      expect((await pool.query("SELECT id FROM ai_apps WHERE provider_connection_id IS NOT NULL")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rowCount).toBe(journal.entries.length);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
