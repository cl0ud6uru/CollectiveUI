import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const suite = process.env.ASYNC_MIGRATION_TEST === "1" ? describe : describe.skip;
suite("native async migration", () => {
  it.each(["fresh", "0019"])("migrates and replays from %s with safe legacy defaults and constraints", async source => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_async_upgrade_test") throw new Error("Named loopback disposable database required");
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "async-migration-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      const previous = JSON.parse(await readFile(path.join(original, "meta/0019_snapshot.json"), "utf8"));
      const next = JSON.parse(await readFile(path.join(original, "meta/0020_snapshot.json"), "utf8"));
      expect(next.prevId).toBe(previous.id);
      expect(journal.entries[20].tag).toBe("0020_native_async_tasks");
      const database = drizzle(pool);
      if (source === "0019") {
        const entries = journal.entries.slice(0, 20);
        await mkdir(path.join(folder, "meta"));
        for (const e of entries) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        await migrate(database, { migrationsFolder: folder });
        await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('async-upgrade-owner','async-upgrade@example.invalid','Fixture','ldap')");
        await pool.query("INSERT INTO conversations(id,user_id,title) VALUES ('async-upgrade-chat','async-upgrade-owner','Keep history')");
        await pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id,status) VALUES ('async-upgrade-run','async-upgrade-owner','async-upgrade-chat','async-upgrade-message','waiting')");
        await pool.query("INSERT INTO delegated_tasks(id,user_id,origin_message_id,origin_tool_call_id,root_task_id,root_message_id,assigner_bot_id,receiver_bot_id,assigner_name,receiver_name,input_hash,ancestry,depth,session_version,deadline_at) VALUES ('async-old-task','async-upgrade-owner','old-reply','old-call','async-old-task','old-reply','old-source','old-receiver','Source','Receiver','hash','[]',1,0,now())");
      }
      await migrate(database, { migrationsFolder: original });
      await migrate(database, { migrationsFolder: original });
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(journal.entries.length);
      if (source === "0019") {
        expect((await pool.query("SELECT mode,parent_segment,notified_at FROM delegated_tasks")).rows).toEqual([{ mode: "sync", parent_segment: 0, notified_at: null }]);
        expect((await pool.query("SELECT status,execution_mode FROM agent_runs")).rows).toEqual([{ status: "waiting", execution_mode: "worker" }]);
        expect((await pool.query("SELECT title,source,is_bot_home FROM conversations")).rows).toEqual([{ title: "Keep history", source: "chat", is_bot_home: false }]);
        await pool.query("UPDATE agent_runs SET status='waiting_tasks' WHERE id='async-upgrade-run'");
        await expect(pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id) VALUES ('duplicate','async-upgrade-owner','async-upgrade-chat','another')")).rejects.toMatchObject({ code: "23505" });
        await expect(pool.query("UPDATE agent_runs SET execution_mode='inline_delegate' WHERE id='async-upgrade-run'")).rejects.toMatchObject({ code: "23514" });
        await expect(pool.query("UPDATE agent_runs SET execution_mode='async_delegate',background=false WHERE id='async-upgrade-run'")).rejects.toMatchObject({ code: "23514" });
        await pool.query("UPDATE agent_runs SET execution_mode='async_delegate',background=true WHERE id='async-upgrade-run'");
      }
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
