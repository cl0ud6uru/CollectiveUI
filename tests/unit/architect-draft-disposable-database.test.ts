import { describe, expect, it } from 'vitest';
import { architectDraftFixtureURL } from '../fixtures/architect-draft/disposable-database';

const url = 'postgres://native_budget_fixture:synthetic-fixture-only@127.0.0.1:5432/collective_architect_draft_proof_test';
const env = { ARCHITECT_DRAFT_POSTGRES_PROOF: '1', ARCHITECT_DRAFT_POSTGRES_TEST_URL: url };

describe('Architect draft PostgreSQL proof target guard (no database imports)', () => {
  it('requires explicit opt-in and never falls back to DATABASE_URL', () => {
    expect(architectDraftFixtureURL({ ...env, DATABASE_URL: 'postgres://private.invalid/production' })).toBe(url);
    for (const value of [{}, { DATABASE_URL: url }, { ...env, ARCHITECT_DRAFT_POSTGRES_PROOF: '0' }, { ...env, ARCHITECT_DRAFT_POSTGRES_TEST_URL: undefined }])
      expect(() => architectDraftFixtureURL(value)).toThrow('Explicit Architect draft proof');
  });
  it.each(['?', '#', '?host=production.invalid', '?hostaddr=192.0.2.1', '?database=production', '?user=other', '?options=-csearch_path=private', '#fragment'])('rejects URL override surfaces: %s', suffix => {
    expect(() => architectDraftFixtureURL({ ...env, ARCHITECT_DRAFT_POSTGRES_TEST_URL: url + suffix })).toThrow('connection overrides');
  });
  it.each(['https://127.0.0.1:5432/collective_architect_draft_proof_test', url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', '192.0.2.1'), url.replace('_proof_test', '_production'), url.replace('native_budget_fixture:', 'postgres:'), url.replace('synthetic-fixture-only', 'actual-secret'), url.replace(':5432/', '/')])('rejects non-exact targets without echoing credentials', raw => {
    expect(() => architectDraftFixtureURL({ ...env, ARCHITECT_DRAFT_POSTGRES_TEST_URL: raw })).toThrow('disposable loopback');
    try { architectDraftFixtureURL({ ...env, ARCHITECT_DRAFT_POSTGRES_TEST_URL: raw }); } catch (error) { expect(String(error)).not.toContain(raw); }
  });
  it.each(['PGHOST', 'PGHOSTADDR', 'PGDATABASE', 'PGOPTIONS', 'PGSERVICE', 'PGSSLMODE'])('rejects environment connection overrides: %s', key => {
    expect(() => architectDraftFixtureURL({ ...env, [key]: 'override' })).toThrow('connection overrides');
  });
});
