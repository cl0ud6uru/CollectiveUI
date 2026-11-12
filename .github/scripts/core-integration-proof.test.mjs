import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCoreIntegrationReport, coreIntegrationSuites } from './core-integration-proof.mjs';

const passing = () => ({
  success: true, numFailedTests: 0, numPendingTests: 0, numTotalTests: 4, numPassedTests: 4,
  testResults: coreIntegrationSuites.map(file => ({
    name: `/checkout/${file}`, status: 'passed', assertionResults: [{ status: 'passed' }],
  })),
});

test('accepts all four executed suites', () => assertCoreIntegrationReport(passing()));
for (const [name, change] of [
  ['failed run', r => { r.success = false; }],
  ['skipped case', r => { r.numPendingTests = 1; r.numPassedTests = 3; r.testResults[0].assertionResults[0].status = 'pending'; }],
  ['missing suite', r => { r.testResults.pop(); }],
  ['duplicate suite', r => { r.testResults[3] = r.testResults[0]; }],
  ['unexpected suite', r => { r.testResults[0].name = '/checkout/tests/integration/hermes-live.test.ts'; }],
  ['empty suite', r => { r.testResults[0].assertionResults = []; }],
  ['failed case hidden by totals', r => { r.testResults[0].assertionResults[0].status = 'failed'; }],
  ['inconsistent totals', r => { r.numTotalTests = 5; r.numPassedTests = 5; }],
]) {
  test(`rejects ${name}`, () => {
    const report = passing();
    change(report);
    assert.throws(() => assertCoreIntegrationReport(report));
  });
}
