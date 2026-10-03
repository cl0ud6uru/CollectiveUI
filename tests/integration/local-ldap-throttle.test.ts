import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { authenticateLdap, ldapConfigFromEnv } from "@/lib/auth/ldap";
import { allowAccountAttempt } from "@/lib/auth/throttle";
const run = process.env.LOCAL_LDAP_TEST === "1" ? describe : describe.skip;
run("canonical directory throttle", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  afterAll(async () => { await pool.end(); const db = await import("@/db"); await db.pool.end(); });
  it("unifies shortname, UPN, email and arbitrary domain prefixes before password bind", async () => {
    if (!process.env.DATABASE_URL?.endsWith("/collective_local_browser_test")) throw new Error("Requires disposable browser fixture database");
    await pool.query("DELETE FROM auth_throttle");
    const identities = new Set<string>();
    const allow = async (dn: string) => { identities.add(dn); return allowAccountAttempt("ldap-dn", dn.toLowerCase()); };
    for (let i = 0; i < 10; i++) expect(await authenticateLdap(`prefix${i}\\alice`, "wrong", ldapConfigFromEnv(), allow)).toBeNull();
    expect(await authenticateLdap("alice@corp.local", "Passw0rd!", ldapConfigFromEnv(), allow)).toBeNull();
    expect(await authenticateLdap("alice", "Passw0rd!", ldapConfigFromEnv(), allow)).toBeNull();
    expect(identities.size).toBe(1);
    await pool.query("DELETE FROM auth_throttle");
    expect(await authenticateLdap("alice", "Passw0rd!", ldapConfigFromEnv(), allow)).toMatchObject({ upn: "alice@corp.local" });
  });
});
