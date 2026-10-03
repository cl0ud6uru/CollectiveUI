import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { describe, expect, it } from "vitest";

const suite = process.env.HERMES_UPGRADE_DATABASE_URL ? describe : describe.skip;
suite("Hermes provisioning migration upgrade", () => {
  it("upgrades main's schema without adopting manual profiles or changing history, and is idempotent", async () => {
    const url = process.env.HERMES_UPGRADE_DATABASE_URL!;
    if (new URL(url).pathname !== "/collective_profiles_upgrade_test") throw new Error("Named disposable database required");
    const pool = new Pool({ connectionString: url });
    const folder = await mkdtemp(path.join(tmpdir(), "hermes-upgrade-"));
    try {
      const original = path.resolve("src/db/migrations");
      await mkdir(path.join(folder, "meta"));
      for (const file of await readdir(original)) if (file.endsWith(".sql") && Number(file.slice(0, 4)) <= 12)
        await writeFile(path.join(folder, file), await readFile(path.join(original, file)));
      const journal = JSON.parse(await readFile(path.join(original, "meta/_journal.json"), "utf8"));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 12);
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: folder });
      await pool.query("INSERT INTO users(id,upn,name,auth_source) VALUES ('upgrade-hermes','upgrade@example.invalid','Upgrade','ldap')");
      await pool.query("INSERT INTO ai_apps(id,name,provider,base_url,model,provider_config,api_key_enc) VALUES ('manual-hermes','Manual','hermes','http://127.0.0.1:8642','model','{\"profile\":\"existing\"}','opaque-existing-ciphertext')");
      await pool.query("INSERT INTO conversations(id,user_id,app_id,title) VALUES ('upgrade-chat','upgrade-hermes','manual-hermes','Keep transcript')");
      await pool.query("INSERT INTO hermes_chat_settings(conversation_id,target_key,model) VALUES ('upgrade-chat','immutable-old-key','fast')");
      await pool.query("INSERT INTO bots(id,owner_id,name,app_id) VALUES ('upgrade-bot','upgrade-hermes','Preserved bot','manual-hermes')");
      await pool.query("INSERT INTO bot_pets(user_id,bot_id,enabled,appearance) VALUES ('upgrade-hermes','upgrade-bot',true,'moss')");
      await migrate(db, { migrationsFolder: original });
      await migrate(db, { migrationsFolder: original });
      expect((await pool.query("SELECT provider_config,api_key_enc FROM ai_apps WHERE id='manual-hermes'")).rows[0]).toEqual({ provider_config: { profile: "existing" }, api_key_enc: "opaque-existing-ciphertext" });
      expect((await pool.query("SELECT title FROM conversations WHERE id='upgrade-chat'")).rows[0].title).toBe("Keep transcript");
      expect((await pool.query("SELECT target_key,model FROM hermes_chat_settings")).rows[0]).toEqual({ target_key: "immutable-old-key", model: "fast" });
      expect((await pool.query("SELECT * FROM hermes_connections")).rows).toEqual([]);
      expect((await pool.query("SELECT * FROM hermes_provisions")).rows).toEqual([]);
      expect((await pool.query("SELECT user_id,bot_id,enabled,appearance FROM bot_pets")).rows).toEqual([{ user_id: "upgrade-hermes", bot_id: "upgrade-bot", enabled: true, appearance: "moss" }]);
    } finally { await pool.end(); await rm(folder, { recursive: true, force: true }); }
  });
});
