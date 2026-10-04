import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

type Entry = { idx: number; when: number; tag: string };
const suite = process.env.ENROLLMENT_PROVIDER_UPGRADE_TEST === "1" ? describe : describe.skip;

suite("stacked provider connections and Hermes enrollment migrations", () => {
  it.each(["fresh", "main0022", "provider0023"] as const)("preserves %s data and replays both migrations safely", async (source) => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_enrollment_provider_upgrade_test") {
      throw new Error("Named loopback disposable enrollment/provider upgrade database required");
    }
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "enrollment-provider-upgrade-"));
    const original = path.resolve("src/db/migrations");
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      const entries: Entry[] = journal.entries;
      expect(entries.map(e => e.idx)).toEqual(Array.from({ length: entries.length }, (_, i) => i));
      expect(entries[23]).toMatchObject({ idx: 23, when: 1791105367231, tag: "0023_saved_provider_connections" });
      expect(entries[24].tag).toBe("0024_docker_hermes_enrollment");
      for (let i = 1; i < entries.length; i++) expect(entries[i].when).toBeGreaterThan(entries[i - 1].when);
      const snap22 = JSON.parse(await readFile(path.join(original, "meta/0022_snapshot.json"), "utf8"));
      const snap23 = JSON.parse(await readFile(path.join(original, "meta/0023_snapshot.json"), "utf8"));
      const snap24 = JSON.parse(await readFile(path.join(original, "meta/0024_snapshot.json"), "utf8"));
      expect(snap23.prevId).toBe(snap22.id);
      expect(snap24.prevId).toBe(snap23.id);
      expect(snap23.tables["public.docker_hermes_enrollments"]).toBeUndefined();
      expect(snap24.tables["public.provider_connections"]).toEqual(snap23.tables["public.provider_connections"]);
      expect(snap24.tables["public.ai_apps"]).toEqual(snap23.tables["public.ai_apps"]);
      expect(snap24.tables["public.docker_hermes_enrollments"].columns.enabled.default).toBe(false);

      const database = drizzle(pool);
      const seedExisting = async () => {
        await pool.query("INSERT INTO users(id,upn,name,auth_source,is_admin) VALUES ('stack-admin','admin@fixture.invalid','Admin','ldap',true),('stack-owner','owner@fixture.invalid','Owner','ldap',false)");
        await pool.query("INSERT INTO groups(id,name) VALUES ('stack-group','Private team')");
        await pool.query("INSERT INTO ai_apps(id,name,provider,model,api_key_enc,provider_config,base_url) VALUES ('stack-legacy','Legacy','openai','fixture','opaque-legacy','{\"project\":\"legacy-project\"}',null),('stack-native','Native','hermes','profile','opaque-native','{\"docker\":{\"owner\":\"stack-owner\",\"profile\":\"retained-profile\",\"binding\":\"retained-binding\"}}','http://127.0.0.1:1')");
        await pool.query("INSERT INTO app_access(app_id,group_id) VALUES ('stack-legacy','stack-group')");
        await pool.query("INSERT INTO bots(id,owner_id,name,app_id) VALUES ('stack-bot','stack-owner','Retained native bot','stack-native')");
        await pool.query("INSERT INTO conversations(id,user_id,bot_id,title) VALUES ('stack-chat','stack-owner','stack-bot','Retained conversation')");
        await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('stack-message','stack-chat','user','[{\"type\":\"text\",\"text\":\"Retained prompt\"}]')");
      };
      const seedProvider = async () => {
        await pool.query("INSERT INTO provider_connections(id,name,secret_enc,organization,project,created_by) VALUES ('stack-connection','Retained connection','opaque-row-bound-ciphertext','retained-org','retained-project','stack-admin')");
        await pool.query("INSERT INTO ai_apps(id,name,provider,model,provider_connection_id) VALUES ('stack-saved','Saved','openai','fixture','stack-connection')");
        await pool.query("INSERT INTO app_access(app_id,group_id) VALUES ('stack-saved','stack-group')");
      };
      if (source !== "fresh") {
        const preceding = entries.filter(e => e.idx <= (source === "main0022" ? 22 : 23));
        await mkdir(path.join(folder, "meta"));
        for (const e of preceding) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: preceding }));
        await migrate(database, { migrationsFolder: folder });
        await seedExisting();
        if (source === "provider0023") await seedProvider();
      }
      const tables = ["users", "groups", "ai_apps", "app_access", "bots", "conversations", "messages", ...(source === "provider0023" ? ["provider_connections"] : [])];
      const before = source === "fresh" ? [] : await Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));
      const historyBefore = source === "fresh" ? [] : (await pool.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      await migrate(database, { migrationsFolder: original });
      if (source !== "fresh") for (let i = 0; i < tables.length; i++) {
        expect((await pool.query(`SELECT * FROM ${tables[i]} ORDER BY 1`)).rows).toMatchObject(before[i].rows);
      }
      expect((await pool.query("SELECT * FROM docker_hermes_enrollments")).rows).toEqual([]);
      const history = (await pool.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
      expect(history.slice(0, historyBefore.length)).toEqual(historyBefore);
      expect(history.map(row => Number(row.created_at))).toEqual(entries.map(e => e.when));

      if (source === "fresh") await seedExisting();
      if (source !== "provider0023") await seedProvider();
      await pool.query("INSERT INTO docker_hermes_enrollments(user_id,changed_by) VALUES ('stack-owner','stack-admin')");
      expect((await pool.query("SELECT enabled,cleanup FROM docker_hermes_enrollments WHERE user_id='stack-owner'")).rows).toEqual([{ enabled: false, cleanup: "none" }]);
      await expect(pool.query("UPDATE docker_hermes_enrollments SET cleanup='invalid' WHERE user_id='stack-owner'")).rejects.toMatchObject({ code: "23514" });
      await expect(pool.query("UPDATE ai_apps SET provider_connection_id='stack-connection' WHERE id='stack-native'")).rejects.toMatchObject({ code: "23514" });
      await pool.query("UPDATE docker_hermes_enrollments SET cleanup='stopped' WHERE user_id='stack-owner'");
      await pool.query("INSERT INTO docker_hermes_enrollments(user_id,enabled,changed_by) VALUES ('stack-admin',true,'stack-admin')");
      const replayTables = [...new Set([...tables, "provider_connections", "docker_hermes_enrollments"])];
      const replayBefore = await Promise.all(replayTables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY 1`)));
      await migrate(database, { migrationsFolder: original });
      await migrate(database, { migrationsFolder: original });
      for (let i = 0; i < replayTables.length; i++) expect((await pool.query(`SELECT * FROM ${replayTables[i]} ORDER BY 1`)).rows).toEqual(replayBefore[i].rows);
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations ORDER BY id")).rows).toEqual(history);
    } finally {
      await pool.end();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
