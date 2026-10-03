import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(import.meta.dirname, "src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      // Needs a Postgres with the schema migrated (DATABASE_URL); each suite skips itself otherwise.
      {
        resolve: { alias },
        test: { name: "integration", include: ["tests/integration/**/*.test.ts"], environment: "node", fileParallelism: false },
      },
      // Needs a Docker host with the sandbox image built; skipped unless SANDBOX_DOCKER=1 (npm run test:sandbox).
      {
        resolve: { alias },
        test: {
          name: "sandbox",
          include: ["tests/sandbox/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
