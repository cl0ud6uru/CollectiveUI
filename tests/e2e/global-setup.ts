import { execFileSync } from "node:child_process";

/** Seed the mock app, demo bot and a group-restricted app used by the access-control tests. */
export default async function globalSetup() {
  execFileSync("npx", ["tsx", "--env-file=.env.local", "tests/e2e/seed-e2e.ts"], { stdio: "inherit" });
}
