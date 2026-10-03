import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const suite = process.env.DELEGATION_MIGRATION_TEST === "1" ? describe : describe.skip;
suite("delegation migration on a named disposable database", () => {
  it.each(["fresh", "0017"])("applies twice from %s without changing old chats or audit identities", async source => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_delegation_upgrade_test") throw new Error("Named loopback disposable database required");
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "delegation-migration-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      expect(journal.entries.slice(0, 20).map((e: { idx: number }) => e.idx)).toEqual(Array.from({ length: 20 }, (_, i) => i));
      expect(journal.entries[19].tag).toBe("0019_delegated_tasks");
      const previous = JSON.parse(await readFile(path.join(original, "meta/0018_snapshot.json"), "utf8"));
      const next = JSON.parse(await readFile(path.join(original, "meta/0019_snapshot.json"), "utf8"));
      expect(next.prevId).toBe(previous.id);
      const database = drizzle(pool);
      if (source === "0017") {
        const entries = journal.entries.slice(0, 18);
        await mkdir(path.join(folder, "meta"));
        for (const e of entries) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        await migrate(database, { migrationsFolder: folder });
        await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('task-upgrade-owner','upgrade@example.invalid','Fixture','ldap')");
        await pool.query("INSERT INTO conversations(id,user_id,title) VALUES ('task-upgrade-chat','task-upgrade-owner','Keep history')");
        await pool.query("INSERT INTO messages(id,conversation_id,role,parts) VALUES ('task-upgrade-message','task-upgrade-chat','assistant','[]')");
        await pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id,status) VALUES ('task-upgrade-run','task-upgrade-owner','task-upgrade-chat','task-upgrade-message','waiting')");
        await pool.query("INSERT INTO tool_calls(id,conversation_id,message_id,user_id,tool_name,status) VALUES ('provider-call','task-upgrade-chat','task-upgrade-message','task-upgrade-owner','fetch_url','pending_approval')");
      }
      await migrate(database, { migrationsFolder: original });
      await migrate(database, { migrationsFolder: original });
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(journal.entries.length);
      expect((await pool.query("SELECT * FROM delegated_tasks")).rows).toHaveLength(0);
      if (source === "0017") {
        expect((await pool.query("SELECT id,title,source,is_bot_home FROM conversations")).rows).toEqual([{ id: "task-upgrade-chat", title: "Keep history", source: "chat", is_bot_home: false }]);
        expect((await pool.query("SELECT status,execution_mode FROM agent_runs")).rows).toEqual([{ status: "waiting", execution_mode: "worker" }]);
        expect((await pool.query("SELECT id,provider_call_id,run_id,status FROM tool_calls")).rows).toEqual([{ id: "provider-call", provider_call_id: "provider-call", run_id: "task-upgrade-run", status: "pending_approval" }]);
        await pool.query("INSERT INTO tool_calls(id,message_id,provider_call_id,tool_name,status) VALUES ('new-scoped-id','task-upgrade-message','provider-call','fetch_url','done') ON CONFLICT(message_id,provider_call_id) DO UPDATE SET status=excluded.status");
        expect((await pool.query("SELECT id,status FROM tool_calls")).rows).toEqual([{ id: "provider-call", status: "done" }]);
      }
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
