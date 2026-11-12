import assert from 'node:assert/strict';

export const coreIntegrationSuites = [
  'tests/integration/provider-roundtrip.test.ts',
  'tests/integration/model-routing.test.ts',
  'tests/integration/runs-exec.test.ts',
  'tests/integration/runs-web.test.ts',
];

/** A green command with missing prerequisites or skipped cases is not integration proof. */
export function assertCoreIntegrationReport(report) {
  assert.equal(report.success, true, 'Core integration run must succeed');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0, 'Every selected integration case must run');
  assert.ok(report.numTotalTests > 0, 'Integration cases must be collected');
  assert.equal(report.numPassedTests, report.numTotalTests);
  assert.ok(Array.isArray(report.testResults));
  assert.equal(report.testResults.length, coreIntegrationSuites.length);
  const remaining = new Set(coreIntegrationSuites);
  let cases = 0;
  for (const result of report.testResults) {
    const name = result.name?.replaceAll('\\', '/');
    const file = [...remaining].find(path => name === path || name?.endsWith('/' + path));
    assert.ok(file, 'Unexpected, duplicate or missing integration suite');
    assert.equal(result.status, 'passed');
    assert.ok(Array.isArray(result.assertionResults) && result.assertionResults.length > 0);
    assert.ok(result.assertionResults.every(test => test.status === 'passed'), 'Every case must pass without skips');
    cases += result.assertionResults.length;
    remaining.delete(file);
  }
  assert.equal(remaining.size, 0);
  assert.equal(cases, report.numTotalTests);
}
