import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Real PostgreSQL semantics in an isolated in-memory database; never uses DATABASE_URL.
describe("0056 web-session migration after unchanged 0054/0055", () => {
  it("upgrades preserved workspace/Codex data, reruns safely, and enforces hashed identities", async () => {
    const pg = new PGlite(); const folder = await mkdtemp(path.join(tmpdir(), "web-sessions-migration-"));
    try {
      await pg.exec(`CREATE TABLE users(id text PRIMARY KEY);
        CREATE TABLE bots(id text PRIMARY KEY);
        CREATE TABLE conversations(id text PRIMARY KEY);
        CREATE TABLE codex_runs(id text PRIMARY KEY);
        CREATE TABLE sandboxes(user_id text PRIMARY KEY, ref text, last_used_at timestamptz, delete_after timestamptz, created_at timestamptz);
        INSERT INTO users VALUES ('owner-a'), ('owner-b');
        INSERT INTO bots VALUES ('bot-a'); INSERT INTO conversations VALUES ('chat-a');
        INSERT INTO codex_runs VALUES ('codex-run-a');
        INSERT INTO sandboxes VALUES ('owner-a','abcdefghijklmnopqrst',now(),null,now());`);
      const journal = JSON.parse(await readFile("src/db/migrations/meta/_journal.json", "utf8"));
      expect(journal.entries.map((e: { idx: number }) => e.idx)).toEqual(Array.from({ length: journal.entries.length }, (_, i) => i));
      const entries = journal.entries.slice(54, 57);
      expect(entries.map((e: { tag: string }) => e.tag)).toEqual(["0054_workspace_contract_foundation", "0055_personal_codex", "0056_web_sessions"]);
      expect(entries[56 - 54].when).toBeGreaterThan(entries[55 - 54].when);
      const [snap55, snap56] = await Promise.all(["0055", "0056"].map(n => readFile(`src/db/migrations/meta/${n}_snapshot.json`, "utf8").then(value => JSON.parse(value))));
      expect(snap56.prevId).toBe(snap55.id);
      const { "public.web_sessions": added, ...unchanged } = snap56.tables;
      expect(unchanged).toEqual(snap55.tables); expect(added.columns.session_id_hash.primaryKey).toBe(true);
      await mkdir(path.join(folder, "meta"));
      for (const entry of entries) await writeFile(path.join(folder, `${entry.tag}.sql`), await readFile(`src/db/migrations/${entry.tag}.sql`));
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: entries.slice(0, 2) }));
      const q = drizzle(pg); await migrate(q, { migrationsFolder: folder });
      await pg.exec(`INSERT INTO workspace_bot_bindings(user_id,bot_id,instance_id) SELECT owner_user_id,'bot-a',id FROM workspace_instances;
        INSERT INTO personal_codex_accounts(user_id,credential_binding,email,workspace_id,plan_type) VALUES ('owner-a','opaque','fixture@example.invalid','workspace-a','fixture');
        INSERT INTO codex_threads(conversation_id,user_id,binding,app_id,thread_id) VALUES ('chat-a','owner-a','opaque','app-a','thread-a');`);
      const tables = ["users", "sandboxes", "workspace_instances", "workspace_bot_bindings", "personal_codex_accounts", "codex_threads", "codex_runs"];
      const before = await Promise.all(tables.map(table => pg.query(`SELECT * FROM ${table}`)));
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      await migrate(q, { migrationsFolder: folder }); await migrate(q, { migrationsFolder: folder });
      for (let i = 0; i < tables.length; i++) expect((await pg.query(`SELECT * FROM ${tables[i]}`)).rows).toEqual(before[i].rows);
      expect((await pg.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(3);
      await pg.exec("INSERT INTO web_sessions VALUES (repeat('a',64),'owner-b',1,now()+interval '1 hour',NULL)");
      await expect(pg.exec("INSERT INTO web_sessions VALUES ('plaintext-cookie','owner-b',1,now(),NULL)")).rejects.toThrow(/hash_check/);
      await expect(pg.exec("INSERT INTO web_sessions VALUES (repeat('b',64),'owner-b',-1,now(),NULL)")).rejects.toThrow(/version_check/);
      await expect(pg.exec("INSERT INTO web_sessions VALUES (repeat('b',64),'missing',1,now(),NULL)")).rejects.toThrow(/foreign key/);
      await pg.exec("DELETE FROM users WHERE id='owner-b'"); expect((await pg.query("SELECT * FROM web_sessions")).rows).toEqual([]);
    } finally { await pg.close(); await rm(folder, { recursive: true, force: true }); }
  }, 30_000);
});
