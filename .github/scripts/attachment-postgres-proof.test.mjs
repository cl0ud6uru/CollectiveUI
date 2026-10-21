import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentPostgresURL, assertAttachmentPostgresReport } from './attachment-postgres-proof.mjs';

const env = () => ({ ATTACHMENT_POSTGRES_PROOF: '1',
  ATTACHMENT_POSTGRES_URL: 'postgres://attachment_fixture:synthetic@127.0.0.1:55445/collective_attachments_test' });
const report = () => ({ success: true, numTotalTests: 19, numPassedTests: 19, numFailedTests: 0, numPendingTests: 0,
  testResults: [
    { name: '/checkout/tests/integration/attachment-lifecycle-postgres.test.ts', status: 'passed', assertionResults: Array.from({ length: 15 }, () => ({ status: 'passed' })) },
    { name: '/checkout/tests/integration/shared-attachments-postgres.test.ts', status: 'passed', assertionResults: Array.from({ length: 4 }, () => ({ status: 'passed' })) },
  ] });

test('accepts only the explicitly enabled fixed disposable endpoint', () => {
  assert.equal(attachmentPostgresURL(env()), env().ATTACHMENT_POSTGRES_URL);
  for (const value of [
    { ...env(), ATTACHMENT_POSTGRES_PROOF: undefined },
    { ...env(), ATTACHMENT_POSTGRES_URL: undefined },
    ...['postgres://fixture@localhost:55445/collective_attachments_test',
      'postgres://fixture@127.0.0.1:5432/collective_attachments_test',
      'postgres://fixture@127.0.0.1:55445/production',
      env().ATTACHMENT_POSTGRES_URL + '?host=elsewhere',
      env().ATTACHMENT_POSTGRES_URL + '#fragment'].map(ATTACHMENT_POSTGRES_URL => ({ ...env(), ATTACHMENT_POSTGRES_URL })),
    { ...env(), PGHOST: 'elsewhere' }, { ...env(), PGOPTIONS: '-c search_path=elsewhere' },
  ]) assert.throws(() => attachmentPostgresURL(value));
});
test('accepts both fully executed suites', () => assert.doesNotThrow(() => assertAttachmentPostgresReport(report())));
test('rejects a skipped run even when Vitest exits successfully', () => {
  const skipped = report(); skipped.numPassedTests = 0; skipped.numPendingTests = 19;
  assert.throws(() => assertAttachmentPostgresReport(skipped));
});
test('rejects skipped cases even with forged aggregate counts', () => {
  const skipped = report(); skipped.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(() => assertAttachmentPostgresReport(skipped));
});
test('rejects missing, duplicate or unrelated suites', () => {
  for (const mutate of [value => value.testResults.pop(),
    value => { value.testResults[1] = value.testResults[0]; },
    value => { value.testResults[0].name = '/checkout/tests/unit/unrelated.test.ts'; }]) {
    const value = report(); mutate(value); assert.throws(() => assertAttachmentPostgresReport(value));
  }
});
