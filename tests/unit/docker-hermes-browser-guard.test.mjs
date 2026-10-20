import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcceptanceRefusal, acceptanceDiagnostic, browserAcceptanceEnvironment, ACCEPTED_APP_SHA } from '../../scripts/lib/docker-hermes-browser-guard.mjs';
const base = {
  CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', DOCKER_HERMES_BROWSER: '1',
  ACCEPTANCE_APP_SHA: ACCEPTED_APP_SHA, ACCEPTANCE_HARNESS_SHA: 'b'.repeat(40), DISPOSABLE_PG_PORT: '25432',
  DATABASE_URL: 'postgres://postgres:fixture-123-1@127.0.0.1:25432/collective_docker_hermes_test',
};
test('accepts only the named loopback CI service with this run’s disposable credentials', () => {
  assert.equal(browserAcceptanceEnvironment(base, 'linux').appSha, ACCEPTED_APP_SHA);
});
for (const [name, patch] of Object.entries({
  'missing opt in': { DOCKER_HERMES_BROWSER: '0' }, 'not CI': { CI: 'false' }, 'not GitHub': { GITHUB_ACTIONS: 'false' },
  'unaccepted source': { ACCEPTANCE_APP_SHA: 'c'.repeat(40) }, 'wrong harness': { ACCEPTANCE_HARNESS_SHA: 'main' },
  'PGHOST override': { PGHOST: 'production.invalid' }, 'empty PGOPTIONS override': { PGOPTIONS: '' },
  'provider credential': { OPENAI_API_KEY: 'not-real' }, 'ambient broker': { DOCKER_HERMES_SOCKET: '/tmp/live.sock' },
  'ambient auth': { AUTH_SECRET: 'not-real' }, 'node preload': { NODE_OPTIONS: '--import not-real' },
  'remote database': { DATABASE_URL: base.DATABASE_URL.replace('127.0.0.1', 'production.invalid') },
  'wrong database': { DATABASE_URL: base.DATABASE_URL.replace('collective_docker_hermes_test', 'portal') },
  'wrong credentials': { DATABASE_URL: base.DATABASE_URL.replace('fixture-123-1', 'postgres') },
  'wrong port': { DATABASE_URL: base.DATABASE_URL.replace('25432', '5432') },
  'query override': { DATABASE_URL: `${base.DATABASE_URL}?host=production.invalid` },
  'empty query': { DATABASE_URL: `${base.DATABASE_URL}?` }, 'empty fragment': { DATABASE_URL: `${base.DATABASE_URL}#` },
  'fragment': { DATABASE_URL: `${base.DATABASE_URL}#anything` }, 'malformed URL': { DATABASE_URL: 'not-a-url' },
})) test(`refuses ${name} before any app/database import`, () => {
  assert.throws(() => browserAcceptanceEnvironment({ ...base, ...patch }, 'linux'), /environment refused/);
});
test('refuses macOS because the real fixture cleanup requires Linux procfs', () => {
  assert.throws(() => browserAcceptanceEnvironment(base, 'darwin'), /environment refused/);
});

test('diagnostics expose only fixed reason codes and known key names', () => {
  assert.throws(() => browserAcceptanceEnvironment({ ...base, PGHOST: 'private-value-do-not-echo' }, 'linux'), error => {
    assert.deepEqual(acceptanceDiagnostic(error), { reasonCode: 'pg_environment_override', environmentKeys: ['PGHOST'] });
    assert.ok(!JSON.stringify(acceptanceDiagnostic(error)).includes('private-value'));
    return true;
  });
  assert.deepEqual(acceptanceDiagnostic(new AcceptanceRefusal('arbitrary-private-code', ['PGprivate-name', 'AUTH_SECRET'])), { reasonCode: 'unexpected_failure', environmentKeys: ['AUTH_SECRET'] });
  assert.deepEqual(acceptanceDiagnostic(new Error('private error body')), { reasonCode: 'unexpected_failure' });
});
test('known ambient configuration reports its name while unknown names remain hidden', () => {
  assert.throws(() => browserAcceptanceEnvironment({ ...base, AZURE_HTTP_USER_AGENT: 'private-value', AZURE_private_name: 'private-value' }, 'linux'), error => {
    assert.deepEqual(acceptanceDiagnostic(error), { reasonCode: 'ambient_configuration', environmentKeys: ['AZURE_HTTP_USER_AGENT'] });
    return true;
  });
});
