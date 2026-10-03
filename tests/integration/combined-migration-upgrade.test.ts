import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

// This suite resets only these explicitly named disposable databases. Run each with no app/worker attached.
const suite = process.env.COMBINED_MIGRATION_TEST === "1" ? describe : describe.skip;
suite("combined Hermes and routine migration lineage", () => {
  it.each(["fresh", "main0012", "hermes0013"] as const)("preserves %s data and applies an idempotent contiguous history", async (source) => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1") throw new Error("Loopback disposable database required");
    url.pathname = `/collective_combined_${source}_test`;
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "combined-migration-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      expect(journal.entries.map((e: { idx: number }) => e.idx)).toEqual(Array.from({ length: journal.entries.length }, (_, i) => i));
      expect(journal.entries[13]).toMatchObject({ tag: "0013_hermes_provisioning", when: 1790910115347 });
      expect(journal.entries[14].tag).toBe("0014_routine_admission_outbox");
      expect(journal.entries[14].when).toBeGreaterThan(journal.entries[13].when);
      const snap13 = JSON.parse(await readFile(path.join(original, "meta/0013_snapshot.json"), "utf8"));
      const snap14 = JSON.parse(await readFile(path.join(original, "meta/0014_snapshot.json"), "utf8"));
      expect(snap14.prevId).toBe(snap13.id);
      expect(snap13.tables["public.routine_runs"].columns.last_enqueue_at).toBeUndefined();
      expect(snap14.tables["public.routine_runs"].columns.last_enqueue_at).toMatchObject({ type: "timestamp with time zone", notNull: false });
      const database = drizzle(pool);
      if (source !== "fresh") {
        const entries = journal.entries.filter((e: { idx: number }) => e.idx <= (source === "main0012" ? 12 : 13));
        await mkdir(path.join(folder, "meta"));
        for (const e of entries) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        await migrate(database, { migrationsFolder: folder });
        await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('upgrade-owner','upgrade@example.invalid','Fixture','ldap')");
        await pool.query("INSERT INTO ai_apps(id,name,provider,base_url,model,provider_config,api_key_enc) VALUES ('upgrade-app','Manual','hermes','http://127.0.0.1:8642','model','{\"profile\":\"existing\"}','opaque-ciphertext')");
        await pool.query("INSERT INTO bots(id,owner_id,name,app_id) VALUES ('upgrade-bot','upgrade-owner','Keep bot','upgrade-app')");
        await pool.query("INSERT INTO conversations(id,user_id,bot_id,title) VALUES ('upgrade-chat','upgrade-owner','upgrade-bot','Keep history')");
        await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('upgrade-message','upgrade-chat','user','[{\"type\":\"text\",\"text\":\"Keep prompt\"}]')");
        await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,appearance) VALUES ('upgrade-owner','upgrade-bot',true,'moss')");
        await pool.query("INSERT INTO routines(id,owner_id,bot_id,name,prompt,trigger_type) VALUES ('upgrade-routine','upgrade-owner','upgrade-bot','Keep routine','fixture','webhook')");
        await pool.query("INSERT INTO routine_runs(id,routine_id,trigger) VALUES ('upgrade-queued','upgrade-routine','manual')");
        await pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id,status) VALUES ('upgrade-run','upgrade-owner','upgrade-chat','upgrade-response','waiting')");
        await pool.query("INSERT INTO hermes_chat_settings(conversation_id,target_key,model) VALUES ('upgrade-chat','keep-target','fast')");
        await pool.query("INSERT INTO hermes_run_contexts(run_id,target_key,upstream_run_id,stop_state) VALUES ('upgrade-run','keep-target','keep-upstream','pending')");
        if (source === "hermes0013") {
          await pool.query("INSERT INTO hermes_connections(id,user_id,boundary_id,dashboard_url,runs_url,protocol,expected_version,expected_display_version,provider,secret_enc,quota) VALUES ('upgrade-connection','upgrade-owner','keep-boundary','http://127.0.0.1:19000','http://127.0.0.1:19001','fixture','fixture','fixture','openai','opaque-secret-ciphertext',3)");
          await pool.query("INSERT INTO hermes_provisions(id,user_id,bot_id,app_id,connection_id,profile,key_slot,spec_hash,status,create_attempted) VALUES ('upgrade-provision','upgrade-owner','upgrade-bot','upgrade-app','upgrade-connection','keep-private-profile',0,'keep-spec-hash','ready',true)");
          await pool.query("UPDATE hermes_run_contexts SET provision_id='upgrade-provision' WHERE run_id='upgrade-run'");
        }
      }
      const tables = source === "fresh" ? [] : ["users", "ai_apps", "bots", "conversations", "messages", "bot_pets", "routines", "agent_runs", "hermes_chat_settings", ...(source === "hermes0013" ? ["hermes_connections", "hermes_provisions", "hermes_run_contexts"] : [])];
      const before = await Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table}`)));
      await migrate(database, { migrationsFolder: original });
      await migrate(database, { migrationsFolder: original });
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(journal.entries.length);
      for (let i = 0; i < tables.length; i++) expect((await pool.query(`SELECT * FROM ${tables[i]}`)).rows).toMatchObject(before[i].rows);
      if (source !== "fresh") {
        expect((await pool.query("SELECT id,status,last_enqueue_at FROM routine_runs")).rows).toEqual([{ id: "upgrade-queued", status: "queued", last_enqueue_at: null }]);
        expect((await pool.query("SELECT target_key,upstream_run_id,stop_state FROM hermes_run_contexts")).rows[0]).toEqual({ target_key: "keep-target", upstream_run_id: "keep-upstream", stop_state: "pending" });
      }
      expect((await pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_name='routine_runs' AND column_name='last_enqueue_at'")).rows).toEqual([{ is_nullable: "YES" }]);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
