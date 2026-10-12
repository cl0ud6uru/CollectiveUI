import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Entirely disposable in-memory PostgreSQL; never reads DATABASE_URL or runs live migrations.
describe("workspace additive foundation migration", () => {
  let pg: PGlite;
  let folder: string;
  let sql: string;
  const recipe = { schemaVersion: 1, runtimeProfileKey: "knowledge-work-v1", seedBundleKey: null,
    networkPolicy: "none", capabilities: { shell: true, officeHeadless: true, dotnet: false, agentBrowserView: false } };

  beforeAll(async () => {
    pg = new PGlite();
    // Only predecessor tables referenced by this additive migration are needed here.
    await pg.exec(`CREATE TABLE users(id text PRIMARY KEY);
      CREATE TABLE bots(id text PRIMARY KEY, owner_id text REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE sandboxes(user_id text PRIMARY KEY REFERENCES users(id), ref text UNIQUE NOT NULL,
        last_used_at timestamptz, delete_after timestamptz, created_at timestamptz NOT NULL);
      INSERT INTO users VALUES ('alice'), ('bob');
      INSERT INTO bots VALUES ('shared-bot','alice');
      INSERT INTO sandboxes VALUES ('alice','abcdefghijklmnopqrst','2026-10-01Z','2026-11-01Z','2026-09-01Z');`);
    sql = await readFile("src/db/migrations/0054_workspace_contract_foundation.sql", "utf8");
    folder = await mkdtemp(path.join(tmpdir(), "workspace-foundation-"));
    await mkdir(path.join(folder, "meta"));
    await writeFile(path.join(folder, "0054_workspace_contract_foundation.sql"), sql);
    const journal = JSON.parse(await readFile("src/db/migrations/meta/_journal.json", "utf8"));
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal,
      entries: [journal.entries.find((entry: { tag: string }) => entry.tag === "0054_workspace_contract_foundation")] }));
    await migrate(drizzle(pg), { migrationsFolder: folder });
  }, 30_000);
  afterAll(async () => { await pg?.close(); if (folder) await rm(folder, { recursive: true, force: true }); });

  it("preserves legacy refs/timestamps and does not allocate bot bindings", async () => {
    const legacy = (await pg.query("SELECT * FROM sandboxes")).rows[0] as Record<string, unknown>;
    const instance = (await pg.query("SELECT * FROM workspace_instances")).rows[0] as Record<string, unknown>;
    expect(instance).toMatchObject({ owner_user_id: "alice", sandbox_ref: legacy.ref,
      template_version_id: null, origin: "legacy_personal", runtime_profile_key: "legacy", provision_state: "missing",
      last_used_at: legacy.last_used_at, delete_after: legacy.delete_after, created_at: legacy.created_at });
    expect(instance.id).not.toContain(legacy.ref);
    expect((await pg.query("SELECT * FROM workspace_bot_bindings")).rows).toEqual([]);
  });

  it("migrator rerun and legacy registration are idempotent", async () => {
    const before = (await pg.query("SELECT * FROM workspace_instances")).rows;
    await migrate(drizzle(pg), { migrationsFolder: folder });
    const registration = sql.split("--> statement-breakpoint").find(part => part.includes("INSERT INTO workspace_instances"))!;
    await pg.exec(registration);
    expect((await pg.query("SELECT * FROM workspace_instances")).rows).toEqual(before);
    expect((await pg.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(1);
  });

  it("pins published versions and instance ownership at the database boundary", async () => {
    await pg.exec("INSERT INTO workspace_templates(id,slug,name) VALUES ('office','knowledge-work','Knowledge Work')");
    await pg.query("INSERT INTO workspace_template_versions(id,template_id,version,recipe,recipe_hash) VALUES ('v1','office',1,$1,$2)", [JSON.stringify(recipe), "a".repeat(64)]);
    // Drafts can change until publication.
    await pg.exec("UPDATE workspace_template_versions SET version=2 WHERE id='v1'; UPDATE workspace_template_versions SET published_at=now() WHERE id='v1'");
    for (const assignment of ["version=3", "recipe_hash=repeat('b',64)", "published_at=NULL", "template_id='missing'"])
      await expect(pg.exec(`UPDATE workspace_template_versions SET ${assignment} WHERE id='v1'`)).rejects.toThrow(/immutable/);
    await expect(pg.exec("DELETE FROM workspace_template_versions WHERE id='v1'")).rejects.toThrow(/cannot be deleted/);
    await pg.exec("UPDATE workspace_template_versions SET retired_at=now() WHERE id='v1'");
    await expect(pg.exec("UPDATE workspace_template_versions SET retired_at=NULL WHERE id='v1'")).rejects.toThrow(/immutable/);
    await expect(pg.exec("UPDATE workspace_instances SET owner_user_id='bob' WHERE owner_user_id='alice'")).rejects.toThrow(/immutable/);
    await expect(pg.exec("UPDATE workspace_instances SET sandbox_ref='zyxwvutsrqponmlkjihg' WHERE owner_user_id='alice'")).rejects.toThrow(/immutable/);
    await pg.exec("UPDATE workspace_instances SET provision_state='ready',delete_after=NULL WHERE owner_user_id='alice'");
  });

  it("rejects cross-owner binding and preserves independent instances for a shared bot", async () => {
    await pg.exec(`INSERT INTO workspace_instances(id,owner_user_id,template_version_id,origin,sandbox_ref,runtime_profile_key)
      VALUES ('alice-office','alice','v1','template','aaaaaaaaaaaaaaaaaaaa','knowledge-work-v1'),
      ('bob-office','bob','v1','template','bbbbbbbbbbbbbbbbbbbb','knowledge-work-v1');`);
    await expect(pg.exec("INSERT INTO workspace_bot_bindings(user_id,bot_id,instance_id) VALUES ('bob','shared-bot','alice-office')")).rejects.toThrow(/foreign key/);
    await pg.exec("INSERT INTO workspace_bot_bindings(user_id,bot_id,instance_id) VALUES ('alice','shared-bot','alice-office'),('bob','shared-bot','bob-office')");
    await expect(pg.exec("INSERT INTO workspace_bot_bindings(user_id,bot_id,instance_id) VALUES ('alice','shared-bot','alice-office')")).rejects.toThrow(/duplicate key/);
    expect((await pg.query("SELECT DISTINCT instance_id FROM workspace_bot_bindings")).rows).toHaveLength(2);
    await expect(pg.exec("DELETE FROM workspace_instances WHERE id='alice-office'")).rejects.toThrow(/foreign key/);
    // Deleting the owner still cascades both its instances and bindings; other owner remains.
    await pg.exec("DELETE FROM sandboxes WHERE user_id='alice'; DELETE FROM users WHERE id='alice'");
    expect((await pg.query("SELECT owner_user_id FROM workspace_instances")).rows).toEqual([{ owner_user_id: "bob" }]);
  });

  it("enforces recipe/version and instance invariants", async () => {
    await expect(pg.query("INSERT INTO workspace_template_versions(id,template_id,version,recipe,recipe_hash) VALUES ('bad','office',0,$1,$2)", [JSON.stringify(recipe), "a".repeat(64)])).rejects.toThrow(/positive_check/);
    await expect(pg.query("INSERT INTO workspace_template_versions(id,template_id,version,recipe,recipe_hash) VALUES ('bad','office',3,$1,$2)", [JSON.stringify({ ...recipe, networkPolicy: "host" }), "a".repeat(64)])).rejects.toThrow(/recipe_check/);
    await expect(pg.exec("INSERT INTO workspace_instances(id,owner_user_id,origin,sandbox_ref,runtime_profile_key) VALUES ('bad','bob','template','cccccccccccccccccccc','legacy')")).rejects.toThrow(/origin_check/);
    await expect(pg.exec("UPDATE workspace_instances SET provision_state='arbitrary' WHERE id='bob-office'")).rejects.toThrow(/state_check/);
  });
});
