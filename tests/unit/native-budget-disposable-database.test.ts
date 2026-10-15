import { describe, expect, it } from 'vitest';
import { nativeBudgetFixtureURL } from '../fixtures/native-budget/disposable-database';
const url = 'postgres://native_budget_fixture:synthetic-fixture-only@127.0.0.1:5432/collective_native_budget_proof_test';
const env = { NATIVE_BUDGET_POSTGRES_PROOF: '1', NATIVE_BUDGET_POSTGRES_TEST_URL: url };
describe('native budget PostgreSQL proof target guard (no database imports)', () => {
  it('requires explicit opt-in and never falls back to configured DATABASE_URL', () => {
    expect(nativeBudgetFixtureURL({ ...env, DATABASE_URL: 'postgres://private.invalid/production' })).toBe(url);
    for (const value of [{}, { DATABASE_URL: url }, { ...env, NATIVE_BUDGET_POSTGRES_PROOF: '0' }, { ...env, NATIVE_BUDGET_POSTGRES_TEST_URL: undefined }])
      expect(() => nativeBudgetFixtureURL(value)).toThrow('Explicit native budget proof');
  });
  it.each(['?', '#', '?host=production.invalid', '?hostaddr=192.0.2.1', '?database=production', '?user=other', '?options=-csearch_path=private', '#fragment'])('rejects all URL override surfaces: %s', suffix => {
    expect(() => nativeBudgetFixtureURL({ ...env, NATIVE_BUDGET_POSTGRES_TEST_URL: url + suffix })).toThrow('connection overrides');
  });
  it.each(['https://127.0.0.1:5432/collective_native_budget_proof_test', url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', '192.0.2.1'), url.replace('_proof_test', '_production'), url.replace('native_budget_fixture:', 'postgres:'), url.replace('synthetic-fixture-only', 'actual-secret'), url.replace(':5432/', '/')])('rejects non-exact targets without echoing credentials', raw => {
    expect(() => nativeBudgetFixtureURL({ ...env, NATIVE_BUDGET_POSTGRES_TEST_URL: raw })).toThrow('disposable loopback');
    try { nativeBudgetFixtureURL({ ...env, NATIVE_BUDGET_POSTGRES_TEST_URL: raw }); } catch (error) { expect(String(error)).not.toContain(raw); }
  });
  it.each(['PGHOST', 'PGHOSTADDR', 'PGDATABASE', 'PGOPTIONS', 'PGSERVICE', 'PGSSLMODE'])('rejects environment connection overrides before pool construction: %s', key => {
    expect(() => nativeBudgetFixtureURL({ ...env, [key]: 'override' })).toThrow('connection overrides');
  });
});
