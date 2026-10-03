import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
const run = process.env.LOCAL_MFA_MIGRATION_URL ? describe : describe.skip;
run("local factor migration with existing local and directory identities", () => {
  it("upgrades current main without changing identities, password hashes, session versions or activating MFA", async () => {
    const url = process.env.LOCAL_MFA_MIGRATION_URL!;
    if (new URL(url).pathname !== "/collective_local_mfa_upgrade_test") throw new Error("Named disposable upgrade database required");
    const pool = new Pool({ connectionString: url }); const folder = await mkdtemp(path.join(tmpdir(), "mfa-upgrade-"));
    const original = path.resolve("src/db/migrations");
    try {
      // This test owns the entire explicitly named disposable database, including reruns.
      await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public");
      await mkdir(path.join(folder, "meta"));
      for (const f of await readdir(original)) if (f.endsWith(".sql")) await writeFile(path.join(folder, f), await readFile(path.join(original, f)));
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 20);
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
      const db = drizzle(pool); await migrate(db, { migrationsFolder: folder });
      const hash = await hashPassword("Synthetic-migration-passphrase!42");
      await pool.query("INSERT INTO users(id,upn,name,auth_source,identity_realm,session_version,is_admin) VALUES ('existing-local','local:fixture','Existing local','local','local',7,true),('existing-directory','fixture@example.invalid','Existing directory','entra','directory',4,false)");
      await pool.query("INSERT INTO local_credentials(user_id,username,password_hash,must_change_password) VALUES ('existing-local','fixture',$1,false)", [hash]);
      await pool.query("INSERT INTO local_login_aliases(login,user_id) VALUES ('fixture','existing-local'),('fixture@example.invalid','existing-local')");
      await pool.query("INSERT INTO conversations(id,user_id,title) VALUES ('existing-chat','existing-local','Preserved chat')");
      const before = (await pool.query("SELECT id,upn,name,auth_source,identity_realm,session_version,is_admin FROM users ORDER BY id")).rows;
      await migrate(db, { migrationsFolder: original }); await migrate(db, { migrationsFolder: original });
      expect((await pool.query("SELECT id,upn,name,auth_source,identity_realm,session_version,is_admin FROM users ORDER BY id")).rows).toEqual(before);
      const credential = (await pool.query("SELECT * FROM local_credentials")).rows[0];
      expect(credential.password_hash).toBe(hash); expect(await verifyPassword("Synthetic-migration-passphrase!42", credential.password_hash)).toBe(true);
      expect(credential.must_change_password).toBe(false);
      expect((await pool.query("SELECT auth_changed_at FROM users")).rows.every(r => r.auth_changed_at === null)).toBe(true);
      expect((await pool.query("SELECT * FROM local_login_aliases")).rows).toHaveLength(2);
      expect((await pool.query("SELECT user_id FROM conversations WHERE id='existing-chat'")).rows[0].user_id).toBe("existing-local");
      for (const table of ["local_security", "local_passkeys", "local_recovery_codes", "auth_flows"]) expect((await pool.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  }, 30000);
});
