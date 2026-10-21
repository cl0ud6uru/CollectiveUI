import { describe, expect, it } from "vitest";
import { routineFixtureURL } from "../fixtures/routines/disposable-database";
const url = "postgres://routine_fixture:synthetic-fixture-only@127.0.0.1:5432/collective_review_routine_admission_test";
const env = { ROUTINE_ADMISSION_TEST: "1", DATABASE_URL: url };
describe("destructive routine PostgreSQL fixture guard", () => {
  it("requires explicit opt-in to exactly the synthetic admission or queue fixture", () => {
    expect(routineFixtureURL("admission", env)).toBe(url);
    expect(routineFixtureURL("queue", { ROUTINE_QUEUE_TEST: "1", DATABASE_URL: url.replace("routine_admission", "queue") })).toContain("/collective_review_queue_test");
    for (const value of [{}, { DATABASE_URL: url }, { ...env, ROUTINE_ADMISSION_TEST: "0" }])
      expect(() => routineFixtureURL("admission", value)).toThrow("Explicit routine proof");
    expect(() => routineFixtureURL("queue", env)).toThrow();
  });
  it.each(["?", "#", "?host=private.invalid", "?hostaddr=192.0.2.1", "?database=production", "?user=other", "?options=-csearch_path=private", "#fragment"])("rejects URL redirection %s", suffix => {
    expect(() => routineFixtureURL("admission", { ...env, DATABASE_URL: url + suffix })).toThrow("connection overrides");
  });
  it.each([url.replace("postgres:", "https:"), url.replace("127.0.0.1", "localhost"), url.replace("127.0.0.1", "192.0.2.1"), url.replace("_test", "_production"), url.replace("routine_fixture:", "postgres:"), url.replace("synthetic-fixture-only", "actual-secret"), url.replace(":5432/", "/")])("rejects non-fixture targets without exposing credentials", target => {
    expect(() => routineFixtureURL("admission", { ...env, DATABASE_URL: target })).toThrow("disposable loopback");
    try { routineFixtureURL("admission", { ...env, DATABASE_URL: target }); } catch (error) { expect(String(error)).not.toContain(target); }
  });
  it.each(["PGHOST", "PGHOSTADDR", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGOPTIONS", "PGSERVICE", "PGSERVICEFILE", "PGSSLMODE", "PGSSLROOTCERT", "PGSSLCERT", "PGSSLKEY", "PGAPPNAME", "PGCONNECT_TIMEOUT", "PGCLIENTENCODING"])("rejects ambient %s", key => {
    expect(() => routineFixtureURL("admission", { ...env, [key]: "override" })).toThrow("connection overrides");
  });
});
