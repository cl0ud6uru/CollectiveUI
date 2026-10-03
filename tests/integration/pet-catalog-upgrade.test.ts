import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";
const run = process.env.PET_MIGRATION_TEST === "1" ? describe : describe.skip;
run("pet catalog migration after service bots", () => {
  it.each(["0014", "0016"])("repairs ambiguous disabled choices from %s without losing private data or replaying the reset", async (source) => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/collective_pet_upgrade_test") throw new Error("Dedicated disposable pet upgrade database required");
    const pool = new Pool({ connectionString: url.toString() });
    const folder = await mkdtemp(path.join(tmpdir(), "pet-upgrade-"));
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public");
      const original = path.resolve("src/db/migrations");
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      expect(journal.entries.map((e: { idx: number }) => e.idx)).toEqual(Array.from({ length: 18 }, (_, i) => i));
      const snap15 = JSON.parse(await readFile(path.join(original, "meta/0015_snapshot.json"), "utf8"));
      const snap16 = JSON.parse(await readFile(path.join(original, "meta/0016_snapshot.json"), "utf8"));
      expect(snap16.prevId).toBe(snap15.id);
      expect(snap16.tables["public.bot_mcp_grants"]).toEqual(snap15.tables["public.bot_mcp_grants"]);
      await mkdir(path.join(folder, "meta"));
      const entries = journal.entries.slice(0, 15);
      for (const e of entries) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      const db = drizzle(pool); await migrate(db, { migrationsFolder: folder });
      for (const name of ["absent", "off", "personal", "import"] ) await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ($1,$1,$1,'ldap')", [name]);
      await pool.query("INSERT INTO bots(id,owner_id,name,visibility) VALUES ('fixture','personal','Fixture','org')");
      await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,appearance) VALUES ('off','fixture',false,'moss'),('personal','fixture',true,'ember')");
      await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,appearance,custom,sprite,revision) VALUES ('import','fixture',false,'custom',$1,$2,'keep-revision')", [JSON.stringify({ displayName: "Keep private", description: "", credit: "Keep credit", spriteVersionNumber: 1 }), Buffer.from("private")]);
      if (source === "0016") {
        const through16 = journal.entries.slice(0, 17);
        for (const e of through16.slice(15)) await writeFile(path.join(folder, `${e.tag}.sql`), await readFile(path.join(original, `${e.tag}.sql`)));
        await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: through16 }));
        await migrate(db, { migrationsFolder: folder });
        for (const name of ["catalog-off", "recent-off"]) await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ($1,$1,$1,'ldap')", [name]);
        await pool.query("INSERT INTO pet_catalog(id,manifest,sprite,revision) VALUES ('keep-draft',$1,$2,'catalog-revision')", [JSON.stringify({ displayName: "Draft remains draft", spriteVersionNumber: 1 }), Buffer.from("catalog")]);
        await pool.query("INSERT INTO bot_pets(user_id,bot_id,mode,appearance,catalog_id) VALUES ('catalog-off','fixture','off','catalog','keep-draft'),('recent-off','fixture','off','ember',null)");
      }
      const before = (await pool.query("SELECT user_id,enabled,appearance,custom,sprite,revision FROM bot_pets ORDER BY user_id")).rows;
      await migrate(db, { migrationsFolder: original }); await migrate(db, { migrationsFolder: original });
      expect((await pool.query("SELECT user_id,enabled,appearance,custom,sprite,revision FROM bot_pets ORDER BY user_id")).rows).toEqual(before);
      expect((await pool.query("SELECT user_id,mode FROM bot_pets ORDER BY user_id")).rows).toEqual([
        ...(source === "0016" ? [{ user_id: "catalog-off", mode: "off" }] : []),
        { user_id: "import", mode: "follow" }, { user_id: "off", mode: "follow" }, { user_id: "personal", mode: "personal" },
        ...(source === "0016" ? [{ user_id: "recent-off", mode: "follow" }] : []),
      ]);
      // An explicit Off after the versioned repair stays Off on subsequent normal migrations.
      await pool.query("UPDATE bot_pets SET mode='off' WHERE user_id='off'");
      await migrate(db, { migrationsFolder: original });
      expect((await pool.query("SELECT mode FROM bot_pets WHERE user_id='off'")).rows).toEqual([{ mode: "off" }]);
      expect((await pool.query("SELECT status FROM pet_catalog")).rows).toEqual(source === "0016" ? [{ status: "draft" }] : []);
      expect((await pool.query("SELECT * FROM bot_pet_defaults")).rows).toEqual([]);
      expect((await pool.query("SELECT execution_mode,revision FROM bots")).rows).toEqual([{ execution_mode: "caller", revision: 1 }]);
      expect((await pool.query("SELECT * FROM drizzle.__drizzle_migrations")).rows).toHaveLength(18);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
