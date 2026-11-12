import path from "node:path";
import { pool } from "./index";
import { runMigrations } from "./migration-runner";
import { installBundledPets } from "@/lib/pets/bundled";

async function main() {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "src/db/migrations");
  try {
    await runMigrations(pool, { migrationsFolder }, db => installBundledPets(undefined, undefined, db));
    console.log("migrations applied");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
