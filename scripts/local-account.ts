/** Operator-only CLI. No HTTP route imports this file. Passwords are read from a hidden TTY prompt. */
import { createInterface, emitKeypressEvents } from "node:readline";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db";
import { localLoginAliases } from "../src/db/schema";
import { createLocalUser, resetLocalPassword } from "../src/lib/auth/local";
import { HttpError } from "../src/lib/authz";
import { PASSWORD_GUIDANCE } from "../src/lib/auth/password";

async function textPrompt(label: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return await new Promise<string>(resolve => rl.question(label, resolve)); }
  finally { rl.close(); }
}
async function secretPrompt(label: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run interactively in a TTY; passwords are never accepted in arguments or environment variables.");
  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
        if (key?.ctrl && key.name === "c") { cleanup(); reject(new Error("Cancelled")); }
        else if (key?.name === "return") { cleanup(); resolve(value); }
        else if (key?.name === "backspace") value = [...value].slice(0, -1).join("");
        else if (text && !key?.ctrl && !/[\x00-\x1f\x7f]/.test(text) && value.length + text.length <= 256) value += text;
      };
      function cleanup() { process.stdin.off("keypress", onKey); }
      process.stdin.on("keypress", onKey);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); }
}
async function main() {
  const command = process.argv[2];
  if (!["bootstrap", "recover-admin"].includes(command) || process.argv.length !== 3 || process.env.LOCAL_AUTH_OPERATOR !== command) {
    throw new Error("Set LOCAL_AUTH_OPERATOR for this command only, then run npm run local-account -- bootstrap (or recover-admin). No other arguments are accepted.");
  }
  if (process.env.AUTH_LOCAL_ENABLED !== "true" || !process.env.DATABASE_URL) throw new Error("Set AUTH_LOCAL_ENABLED=true and an explicit DATABASE_URL first.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("An interactive TTY is required.");
  const username = await textPrompt(command === "bootstrap" ? "New admin username: " : "Existing local admin username or email: ");
  const name = command === "bootstrap" ? await textPrompt("Display name: ") : "";
  const email = command === "bootstrap" ? await textPrompt("Email (optional): ") : "";
  console.log(PASSWORD_GUIDANCE);
  const password = await secretPrompt("New password (hidden): ");
  if (password !== await secretPrompt("Confirm password (hidden): ")) throw new Error("Passwords do not match.");
  if (command === "bootstrap") await createLocalUser({ username, name, email, password, isAdmin: true }, "bootstrap");
  else {
    const [alias] = await db.select().from(localLoginAliases).where(eq(localLoginAliases.login, username.trim().toLowerCase()));
    if (!alias) throw new Error("Local administrator not found.");
    await resetLocalPassword("recover-admin", alias.userId, password);
  }
  console.log(command === "bootstrap" ? "Local administrator initialized." : "Local administrator recovered and enabled. All previous sessions revoked.");
}
main().catch(err => {
  // Never print database errors/parameters, stack traces, hashes, or credentials.
  console.error(err instanceof HttpError ? err.message : "Operator command failed. Check the command, input policy and database configuration; no credentials have been logged.");
  process.exitCode = 1;
}).finally(() => pool.end());
