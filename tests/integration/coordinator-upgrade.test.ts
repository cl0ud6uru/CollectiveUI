import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const suite = process.env.COORDINATOR_UPGRADE_TEST === "1" ? describe : describe.skip;
suite("published coordinator plus linked and async task migration lineage", () => {
  it.each(["fresh", "main0017", "coordinator0018", "public0022"] as const)("preserves %s data, grants and pets with contiguous history and idempotent replay", async (source) => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_coordinator_upgrade_test") throw new Error("Disposable coordinator upgrade DB required");
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "coordinator-upgrade-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      expect(journal.entries.map((e: { idx: number }) => e.idx)).toEqual(Array.from({ length: journal.entries.length }, (_, i) => i));
      for (const [i, entry] of journal.entries.entries()) {
        expect(entry.tag.slice(0, 4)).toBe(String(i).padStart(4, "0"));
        if (i > 0) expect(entry.when).toBeGreaterThan(journal.entries[i - 1].when);
      }
      expect(journal.entries[18]).toMatchObject({ idx: 18, tag: "0018_default_coordinator", when: 1790985940212 });
      expect(journal.entries.at(-1)).toMatchObject({ idx: 23, tag: "0023_coordinator_roles" });
      const previous = JSON.parse(await readFile(path.join(original, "meta/0017_snapshot.json"), "utf8"));
      const current = JSON.parse(await readFile(path.join(original, "meta/0018_snapshot.json"), "utf8"));
      expect(current.prevId).toBe(previous.id);
      expect(current.tables["public.bots"].columns.coordinator_eligible).toMatchObject({ type: "boolean", notNull: true, default: false });
      delete current.tables["public.bots"].columns.coordinator_eligible;
      expect(current.tables).toEqual(previous.tables); // no unpublished task schema in this migration
      for (const i of [19, 20, 21, 22, 23]) {
        const a = JSON.parse(await readFile(path.join(original, `meta/${String(i - 1).padStart(4, "0")}_snapshot.json`), "utf8"));
        const b = JSON.parse(await readFile(path.join(original, `meta/${String(i).padStart(4, "0")}_snapshot.json`), "utf8"));
        expect(b.prevId).toBe(a.id);
      }
      const entries = journal.entries.filter((e: { idx: number }) => e.idx <= (source === "public0022" ? 22 : source === "coordinator0018" ? 18 : 17));
      await mkdir(path.join(folder, "meta"));
      for (const e of entries) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      const db = drizzle(pool);
      if (source !== "fresh") {
        await migrate(db, { migrationsFolder: folder });
        await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('upgrade-owner','upgrade@fixture.invalid','Owner','ldap')");
        await pool.query("UPDATE users SET prefs=$1 WHERE id='upgrade-owner'", [JSON.stringify({ customInstructions: "Keep user instructions", memoryEnabled: false,
          ...(source === "coordinator0018" ? { defaultBotId: "upgrade-bot" } : { defaultAppId: "upgrade-app" }) })]);
        await pool.query("INSERT INTO ai_apps(id,name,provider,model,base_url) VALUES ('upgrade-app','Keep model','openai-compatible','fixture','http://127.0.0.1:1')");
        await pool.query("INSERT INTO bots(id,owner_id,name,avatar,instructions,app_id,visibility) VALUES ('upgrade-bot','upgrade-owner','Lloyd GPT','🟣','Keep personality','upgrade-app','private')");
        await pool.query("INSERT INTO conversations(id,user_id,bot_id,title,is_bot_home) VALUES ('upgrade-home','upgrade-owner','upgrade-bot','Keep private home',true)");
        await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('upgrade-message','upgrade-home','user','[{\"type\":\"text\",\"text\":\"Private history\"}]')");
        await pool.query("INSERT INTO settings(key,value) VALUES ('branding','{\"defaultAppId\":\"upgrade-app\",\"appName\":\"Keep name\"}')");
        await pool.query("INSERT INTO bot_tools(bot_id,tool_key,approval) VALUES ('upgrade-bot','memory','ask')");
        await pool.query("INSERT INTO tool_grants(user_id,bot_id,tool_name) VALUES ('upgrade-owner','upgrade-bot','remember')");
        await pool.query("INSERT INTO user_bot_prefs(user_id,bot_id,pinned) VALUES ('upgrade-owner','upgrade-bot',true)");
        await pool.query("INSERT INTO pet_catalog(id,created_by,manifest,sprite,revision,status) VALUES ('upgrade-pet','upgrade-owner','{\"name\":\"Keep pet\"}',decode('010203','hex'),'keep-revision','published')");
        await pool.query("INSERT INTO bot_pet_defaults(bot_id,appearance,catalog_id,updated_by) VALUES ('upgrade-bot','catalog','upgrade-pet','upgrade-owner')");
        await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,appearance,catalog_id) VALUES ('upgrade-owner','upgrade-bot',true,'catalog','upgrade-pet')");
        if (source === "coordinator0018") {
          await pool.query("UPDATE settings SET value=$1 WHERE key='branding'", [JSON.stringify({ appName: "Keep name", defaultBotId: "upgrade-bot" })]);
          await pool.query("UPDATE bots SET coordinator_eligible=true WHERE id='upgrade-bot'");
          await pool.query("INSERT INTO settings(key,value) VALUES ('coordinator','{\"enabled\":true,\"defaultBotId\":\"upgrade-bot\",\"starterBotId\":\"upgrade-bot\"}')");
        }
      }
      const tables = source !== "fresh" ? ["users", "ai_apps", "bots", "conversations", "messages", "settings", "bot_tools", "tool_grants", "user_bot_prefs", "pet_catalog", "bot_pet_defaults", "bot_pets"] : [];
      const before = await Promise.all(tables.map(t => pool.query(`SELECT * FROM ${t}`)));
      await migrate(db, { migrationsFolder: original });
      await migrate(db, { migrationsFolder: original });
      for (let i = 0; i < tables.length; i++) expect((await pool.query(`SELECT * FROM ${tables[i]}`)).rows).toMatchObject(before[i].rows);
      expect((await pool.query("SELECT id,coordinator_eligible,is_coordinator FROM bots")).rows).toEqual(source !== "fresh" ? [{ id: "upgrade-bot", coordinator_eligible: source === "coordinator0018", is_coordinator: false }] : []);
      expect((await pool.query("SELECT * FROM settings WHERE key='coordinator'")).rowCount).toBe(source === "coordinator0018" ? 1 : 0);
      expect((await pool.query("SELECT * FROM delegated_tasks")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(journal.entries.length);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
