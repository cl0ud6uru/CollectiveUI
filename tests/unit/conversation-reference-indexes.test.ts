import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const migration = "0068_conversation_reference_indexes.sql";
const references = [
  ["delegated_tasks", "origin_conversation_id", "delegated_tasks_origin_conversation_idx"],
  ["group_bot_work", "conversation_id", "group_bot_work_conversation_idx"],
  ["hosted_search_budgets", "conversation_id", "hosted_search_budgets_conversation_idx"],
  ["routine_runs", "conversation_id", "routine_runs_conversation_idx"],
  ["shared_links", "conversation_id", "shared_links_conversation_idx"],
  ["tool_calls", "conversation_id", "tool_calls_conversation_idx"],
] as const;

it("adds usable conversation and profile indexes without changing rows or deletion semantics", async () => {
  const db = new PGlite();
  const folder = "src/db/migrations";
  const sql = (name: string) => readFileSync(`${folder}/${name}`, "utf8")
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]");
  try {
    await db.waitReady;
    for (const file of readdirSync(folder).filter(name => name.endsWith(".sql") && name < migration).sort()) await db.exec(sql(file));
    await db.exec(`
      INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES ('owner','index@fixture.invalid','Index fixture','local','local');
      INSERT INTO bots(id,owner_id,name) VALUES ('bot','owner','Fixture bot');
      INSERT INTO conversations(id,user_id,bot_id) VALUES ('retained','owner','bot'), ('deleted','owner','bot');
      INSERT INTO routines(id,owner_id,bot_id,name,prompt,trigger_type,cron) VALUES ('routine','owner','bot','Fixture','Synthetic','cron','0 9 * * *');
      INSERT INTO routine_runs(id,routine_id,trigger,conversation_id) VALUES ('run','routine','schedule','deleted');
      INSERT INTO shared_links(id,conversation_id,cutoff_message_id,created_by) VALUES ('share','deleted','message','owner');
      INSERT INTO hosted_search_budgets(message_id,conversation_id,max_calls) VALUES ('budget','deleted',1);
      INSERT INTO group_bot_work(id,user_id,conversation_id,bot_id,expires_at) VALUES ('work','owner','deleted','bot',now());
      INSERT INTO delegated_tasks(id,user_id,origin_conversation_id,origin_message_id,origin_tool_call_id,root_task_id,root_message_id,assigner_bot_id,receiver_bot_id,assigner_name,receiver_name,input_hash,session_version,deadline_at,depth,ancestry)
        VALUES ('task','owner','deleted','message','call','task','message','bot','bot','Fixture','Fixture','hash',0,now(),1,'[]');
      INSERT INTO tool_calls(id,conversation_id,user_id,bot_id,tool_name,status)
        SELECT 'tool-' || n, CASE WHEN n % 2 = 0 THEN 'retained' ELSE 'deleted' END, 'owner','bot','fixture','done' FROM generate_series(1,500) n;
    `);
    const tables = [...references.map(([table]) => table), "conversations"];
    const rows = async () => Promise.all(tables.map(async table => (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows));
    const before = await rows();
    await db.exec("SET enable_seqscan = off");
    for (const [table, column] of references) {
      const plan = await db.query(`EXPLAIN SELECT * FROM ${table} WHERE ${column} = 'deleted'`);
      expect(JSON.stringify(plan.rows), `prior migration: ${table}`).toContain("Seq Scan");
    }
    await db.exec(sql(migration));
    expect(await rows()).toEqual(before);
    for (const [table, column, index] of references) {
      const plan = await db.query(`EXPLAIN SELECT * FROM ${table} WHERE ${column} = 'deleted'`);
      expect(JSON.stringify(plan.rows), table).toContain(index);
    }
    const profile = await db.query("EXPLAIN SELECT * FROM tool_calls WHERE user_id='owner' AND bot_id='bot' ORDER BY created_at DESC LIMIT 20");
    expect(JSON.stringify(profile.rows)).toContain("tool_calls_user_bot_created_idx");
    expect(JSON.stringify(profile.rows)).not.toContain('Sort Key');
    await db.exec("DELETE FROM conversations WHERE id='deleted'");
    for (const table of ["group_bot_work", "hosted_search_budgets", "shared_links"]) expect((await db.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows).toEqual([{ count: 0 }]);
    expect((await db.query("SELECT count(*)::integer AS count FROM tool_calls")).rows).toEqual([{ count: 250 }]);
    expect((await db.query("SELECT origin_conversation_id FROM delegated_tasks WHERE id='task'")).rows).toEqual([{ origin_conversation_id: null }]);
    expect((await db.query("SELECT conversation_id FROM routine_runs WHERE id='run'")).rows).toEqual([{ conversation_id: null }]);
  } finally { await db.close(); }
}, 30_000);
