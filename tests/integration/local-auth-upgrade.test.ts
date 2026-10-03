import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
const run = process.env.LOCAL_AUTH_UPGRADE_DATABASE_URL ? describe : describe.skip;
run("upgrade from main migration 0010", () => {
  it("preserves directory users, roles, memberships and chats; remains idempotent", async () => {
    const url = process.env.LOCAL_AUTH_UPGRADE_DATABASE_URL!;
    if (new URL(url).pathname !== "/collective_local_upgrade_test") throw new Error("Upgrade test needs its named disposable database");
    const pool = new Pool({ connectionString: url });
    const folder = await mkdtemp(path.join(tmpdir(), "local-upgrade-"));
    try {
      const original = path.resolve("src/db/migrations");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(folder, "meta"));
      for (const file of await readdir(original)) if (file.endsWith(".sql") && !file.startsWith("0011")) await writeFile(path.join(folder, file), await readFile(path.join(original, file)));
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 10);
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: folder });
      await pool.query("INSERT INTO users (id,upn,name,auth_source,is_admin) VALUES ('upgrade-ldap','upgrade@example.invalid','Upgrade LDAP','ldap',true), ('upgrade-entra','entra@example.invalid','Upgrade Entra','entra',false)");
      await pool.query("INSERT INTO user_external_groups(user_id,source,external_id) VALUES ('upgrade-ldap','ldap','fixture-dn')");
      await pool.query("INSERT INTO conversations(id,user_id,title) VALUES ('upgrade-chat','upgrade-ldap','Preserved fixture chat')");
      await migrate(db, { migrationsFolder: original });
      await migrate(db, { migrationsFolder: original });
      const { rows } = await pool.query("SELECT id,auth_source,identity_realm,session_version,is_admin FROM users ORDER BY id");
      expect(rows).toEqual([
        { id: "upgrade-entra", auth_source: "entra", identity_realm: "directory", session_version: 0, is_admin: false },
        { id: "upgrade-ldap", auth_source: "ldap", identity_realm: "directory", session_version: 0, is_admin: true },
      ]);
      expect((await pool.query("SELECT * FROM local_credentials")).rows).toHaveLength(0);
      expect((await pool.query("SELECT user_id FROM conversations WHERE id='upgrade-chat'")).rows[0].user_id).toBe("upgrade-ldap");
      expect((await pool.query("SELECT * FROM user_external_groups")).rows).toHaveLength(1);
      await pool.query("INSERT INTO users(id,upn,name,auth_source,identity_realm) VALUES ('upgrade-local','upgrade@example.invalid','Separate local','local','local')");
      expect((await pool.query("SELECT id FROM users WHERE upn='upgrade@example.invalid'")).rows).toHaveLength(2);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
