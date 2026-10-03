import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const suite = process.env.FOLLOWUP_MIGRATION_TEST === "1" ? describe : describe.skip;
suite("delegation follow-up migration", () => {
  it.each(["fresh", "0021"])("migrates twice from %s, preserving history and enforcing one executing turn", async source => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_followups_upgrade_test") throw new Error("Named disposable follow-up upgrade DB required");
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "followups-upgrade-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      const previous = JSON.parse(await readFile(path.join(original, "meta/0021_snapshot.json"), "utf8"));
      const next = JSON.parse(await readFile(path.join(original, "meta/0022_snapshot.json"), "utf8"));
      expect(next.prevId).toBe(previous.id);
      const database = drizzle(pool);
      if (source === "0021") {
        const entries = journal.entries.slice(0, 22); await mkdir(path.join(folder, "meta"));
        for (const entry of entries) await writeFile(path.join(folder, `${entry.tag}.sql`), await readFile(path.join(original, `${entry.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        await migrate(database, { migrationsFolder: folder });
        await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('owner','upgrade@test.invalid','Fixture','ldap')");
        await pool.query("INSERT INTO conversations(id,user_id,title,source) VALUES ('child','owner','Keep task','delegation'),('ordinary','owner','Regular chat','chat')");
        await pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id,status,execution_mode) VALUES ('old-run','owner','child','old-message','succeeded','inline_delegate')");
        await pool.query("INSERT INTO delegated_tasks(id,user_id,origin_message_id,origin_tool_call_id,root_task_id,root_message_id,assigner_bot_id,receiver_bot_id,assigner_name,receiver_name,child_conversation_id,child_run_id,input_hash,ancestry,depth,session_version,deadline_at,returned_at,parent_result_seq) VALUES ('old-task','owner','origin-message','call','old-task','origin-message','source','receiver','Source','Receiver','child','old-run','hash','[]',1,0,now(),now(),7)");
      }
      await migrate(database, { migrationsFolder: original }); await migrate(database, { migrationsFolder: original });
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(journal.entries.length);
      if (source === "0021") {
        expect((await pool.query("SELECT turn,continued_from_task_id,parent_result_seq FROM delegated_tasks")).rows).toEqual([{ turn: 1, continued_from_task_id: null, parent_result_seq: 7 }]);
        expect((await pool.query("SELECT title FROM conversations WHERE id='child'")).rows[0].title).toBe("Keep task");
        await pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id,status,execution_mode,background) VALUES ('one','owner','child','one-message','queued','async_delegate',true),('two','owner','child','two-message','queued','async_delegate',true)");
        await pool.query("UPDATE agent_runs SET status='running' WHERE id='one'");
        await expect(pool.query("UPDATE agent_runs SET status='running' WHERE id='two'")).rejects.toMatchObject({ code: "23505" });
        await pool.query("UPDATE agent_runs SET status='waiting_tasks' WHERE id='one'");
        await expect(pool.query("UPDATE agent_runs SET status='running' WHERE id='two'")).rejects.toMatchObject({ code: "23505" });
        await pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id) VALUES ('regular','owner','ordinary','regular-message')");
        await expect(pool.query("INSERT INTO agent_runs(id,user_id,conversation_id,message_id) VALUES ('duplicate','owner','ordinary','duplicate-message')")).rejects.toMatchObject({ code: "23505" });
        await expect(pool.query("UPDATE delegated_tasks SET turn=0")).rejects.toMatchObject({ code: "23514" });
      }
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
