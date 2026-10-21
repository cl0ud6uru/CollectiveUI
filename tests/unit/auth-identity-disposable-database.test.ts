import { describe, expect, it } from "vitest";
import { authIdentityFixtureURL } from "../fixtures/auth-identity/disposable-database";

const url = "postgres://fixture_auth:synthetic-auth-only@127.0.0.1:5432/collective_auth_identity_test";
const env = { AUTH_IDENTITY_POSTGRES_PROOF: "1", AUTH_IDENTITY_POSTGRES_TEST_URL: url };
describe("auth identity destructive fixture guard (no DB imports)", () => {
  it("requires opt-in and an independent fixture URL without using configured credentials", () => {
    expect(authIdentityFixtureURL({ ...env, DATABASE_URL: "postgres://private.invalid/production" })).toBe(url);
    expect(authIdentityFixtureURL({ ...env, AUTH_IDENTITY_POSTGRES_TEST_URL: url.replace(":5432/", ":55444/") })).toContain(":55444/");
    for (const value of [{}, { DATABASE_URL: url }, { ...env, AUTH_IDENTITY_POSTGRES_PROOF: "0" }, { ...env, AUTH_IDENTITY_POSTGRES_TEST_URL: undefined }])
      expect(() => authIdentityFixtureURL(value)).toThrow("Explicit auth identity proof");
  });
  it.each(["?", "#", "?host=private.invalid", "?hostaddr=192.0.2.1", "?database=production", "?user=other", "?options=-csearch_path=private", "#fragment"])("rejects connection redirection: %s", suffix => {
    expect(() => authIdentityFixtureURL({ ...env, AUTH_IDENTITY_POSTGRES_TEST_URL: url + suffix })).toThrow("connection overrides");
  });
  it.each([url.replace("postgres:", "https:"), url.replace("127.0.0.1", "localhost"), url.replace("127.0.0.1", "192.0.2.1"), url.replace("_test", "_production"), url.replace("fixture_auth:", "postgres:"), url.replace("synthetic-auth-only", "actual-secret"), url.replace(":5432/", "/")])("rejects other targets without printing credentials", target => {
    expect(() => authIdentityFixtureURL({ ...env, AUTH_IDENTITY_POSTGRES_TEST_URL: target })).toThrow("disposable loopback");
    try { authIdentityFixtureURL({ ...env, AUTH_IDENTITY_POSTGRES_TEST_URL: target }); } catch (error) { expect(String(error)).not.toContain(target); }
  });
  it.each(["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGOPTIONS", "PGSERVICE", "PGSERVICEFILE", "PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGAPPNAME", "PGCONNECT_TIMEOUT", "PGCLIENTENCODING"])("rejects environment overrides: %s", key => {
    expect(() => authIdentityFixtureURL({ ...env, [key]: "override" })).toThrow("connection overrides");
  });
});
