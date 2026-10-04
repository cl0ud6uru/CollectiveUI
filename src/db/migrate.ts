import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { db, pool } from "./index";
import { installBundledPets } from "@/lib/pets/bundled";

async function main() {
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), "src/db/migrations");
  await migrate(db, { migrationsFolder });
  await installBundledPets();
  console.log("migrations applied");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
