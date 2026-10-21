import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("adds dormant event storage after current main while preserving cron and webhook routines", async () => {
  const client = new PGlite();
  const folder = "src/db/migrations";
  const sql = (file: string) => readFileSync(`${folder}/${file}`, "utf8")
    .replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]");
  try {
    await client.waitReady;
    for (const file of readdirSync(folder).filter(f => f.endsWith(".sql") && f < "0067_").sort())
      await client.exec(sql(file));
    await client.exec(`
      INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES ('owner','owner@fixture.invalid','Fixture owner','local','local');
      INSERT INTO bots(id,owner_id,name) VALUES ('bot','owner','Fixture bot');
      INSERT INTO routines(id,owner_id,bot_id,name,prompt,trigger_type,cron,webhook_secret) VALUES
        ('cron','owner','bot','Scheduled','Synthetic instruction','cron','0 9 * * *',NULL),
        ('webhook','owner','bot','Webhook','Synthetic instruction','webhook',NULL,'opaque-retained-secret');
      INSERT INTO routine_runs(id,routine_id,trigger,status) VALUES ('old-run','cron','schedule','succeeded');
    `);
    const before = (await client.query<Record<string, unknown>>("SELECT * FROM routines ORDER BY id")).rows;
    await client.exec(sql("0067_event_triggers.sql"));
    const after = (await client.query<Record<string, unknown>>("SELECT * FROM routines ORDER BY id")).rows;
    expect(after.map(({ trigger_config, trigger_provider, trigger_connection_id, ...row }) => {
      expect([trigger_config, trigger_provider, trigger_connection_id]).toEqual([null, null, null]);
      return row;
    })).toEqual(before);
    expect((await client.query("SELECT trigger_event_id FROM routine_runs WHERE id='old-run'")).rows).toEqual([{ trigger_event_id: null }]);

    await client.exec(`
      INSERT INTO trigger_connections(id,provider,external_id,display_name,installed_by) VALUES ('connection','synthetic','workspace','Fixture','owner');
      INSERT INTO trigger_events(id,provider,connection_id,external_event_id,event_type) VALUES ('event','synthetic','connection','delivery','message');
      INSERT INTO routine_runs(id,routine_id,trigger,trigger_event_id) VALUES ('event-run','cron','event','event');
      INSERT INTO routine_runs(id,routine_id,trigger) VALUES ('legacy-run-1','cron','manual'), ('legacy-run-2','cron','manual');
    `);
    await expect(client.exec("INSERT INTO trigger_events(id,provider,external_event_id,event_type) VALUES ('duplicate','synthetic','delivery','message')")).rejects.toThrow();
    await expect(client.exec("INSERT INTO routine_runs(id,routine_id,trigger,trigger_event_id) VALUES ('duplicate-run','cron','event','event')")).rejects.toThrow();
    await client.exec("INSERT INTO routine_runs(id,routine_id,trigger,trigger_event_id) VALUES ('other-routine-run','webhook','event','event')");
    await expect(client.exec("UPDATE routines SET trigger_type='unsupported' WHERE id='cron'")).rejects.toThrow();
    await client.exec("UPDATE routines SET trigger_type='event',trigger_provider='synthetic',trigger_connection_id='connection' WHERE id='webhook'");
    await client.exec("DELETE FROM trigger_connections WHERE id='connection'");
    expect((await client.query("SELECT trigger_connection_id FROM routines WHERE id='webhook'")).rows).toEqual([{ trigger_connection_id: null }]);
    expect((await client.query("SELECT id FROM trigger_events")).rows).toEqual([]);
    expect((await client.query("SELECT trigger_event_id FROM routine_runs WHERE id='event-run'")).rows).toEqual([{ trigger_event_id: "event" }]);
  } finally { await client.close(); }
}, 30_000);

it("retains prior snapshots and chains the event schema after the existing MCP Apps migration", () => {
  const snapshot = (number: string) => JSON.parse(readFileSync(`src/db/migrations/meta/${number}_snapshot.json`, "utf8"));
  const before = snapshot("0065"), currentMain = snapshot("0066"), event = snapshot("0067");
  expect(currentMain.prevId).toBe(before.id);
  expect(event.prevId).toBe(currentMain.id);
  expect(Object.keys(currentMain.tables).filter(name => !before.tables[name]).sort()).toEqual(["public.mcp_app_actions", "public.mcp_app_instances"]);
  for (const name of Object.keys(before.tables)) expect(currentMain.tables[name], name).toEqual(before.tables[name]);
  expect(Object.keys(event.tables).filter(name => !currentMain.tables[name]).sort()).toEqual(["public.trigger_connections", "public.trigger_events"]);
  for (const name of Object.keys(currentMain.tables))
    if (!["public.routines", "public.routine_runs"].includes(name)) expect(event.tables[name], name).toEqual(currentMain.tables[name]);
  const journal = JSON.parse(readFileSync("src/db/migrations/meta/_journal.json", "utf8"));
  expect(journal.entries[66].tag).toBe("0066_mcp_apps");
  expect(journal.entries[67]).toMatchObject({ idx: 67, tag: "0067_event_triggers" });
  expect(journal.entries[67].when).toBeGreaterThan(journal.entries[66].when);
});
