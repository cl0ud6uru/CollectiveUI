import assert from 'node:assert/strict';

/** Match the existing opt-in suites' fixed disposable target before importing any database driver. */
export function attachmentPostgresURL(env = process.env) {
  assert.equal(env.ATTACHMENT_POSTGRES_PROOF, '1', 'Attachment PostgreSQL proof must be explicitly enabled');
  const url = new URL(env.ATTACHMENT_POSTGRES_URL ?? 'invalid:');
  assert.ok(url.protocol === 'postgres:' && url.hostname === '127.0.0.1' && url.port === '55445'
    && url.pathname === '/collective_attachments_test' && !url.search && !url.hash
    && !Object.keys(env).some(key => key.startsWith('PG') && env[key]),
  'Requires the dedicated loopback attachment database with no PG overrides');
  return url.href;
}

export function assertAttachmentPostgresReport(report) {
  assert.equal(report.success, true, 'PostgreSQL test run must succeed');
  assert.equal(report.numTotalTests, 19, 'Expected all 19 attachment PostgreSQL cases');
  assert.equal(report.numPassedTests, 19, 'Skipped or missing attachment cases are not acceptance');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.ok(Array.isArray(report.testResults));
  assert.equal(report.testResults.length, 2, 'Both exact PostgreSQL suites must be present');
  const suites = new Map([
    ['tests/integration/attachment-lifecycle-postgres.test.ts', 15],
    ['tests/integration/shared-attachments-postgres.test.ts', 4],
  ]);
  for (const result of report.testResults) {
    const file = [...suites.keys()].find(name => result.name?.replaceAll('\\', '/').endsWith('/' + name));
    assert.ok(file, 'Unexpected or duplicate PostgreSQL suite');
    assert.equal(result.status, 'passed');
    assert.equal(result.assertionResults.length, suites.get(file));
    assert.ok(result.assertionResults.every(test => test.status === 'passed'), 'Every case must run and pass');
    suites.delete(file);
  }
  assert.equal(suites.size, 0, 'Missing PostgreSQL suite');
}
