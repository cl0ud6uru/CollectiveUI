import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseDiagnostic, diagnosticContext, safeDiagnostics, SPEC_FILE } from '../../scripts/lib/docker-hermes-browser-reporter.mjs';
const context = diagnosticContext("test('safe source case', async () => {\n  expect(true).toBe(false);\n});\n", '/accepted/tests/e2e/docker-hermes.spec.ts');
test('reports an exact accepted-spec failure location without raw names, errors, paths or values', () => {
  const secret = 'https://private.invalid/?token=synthetic-private-value';
  const result = caseDiagnostic({ title: 'safe source case' }, { status: 'failed', errors: [{ message: secret, stack: secret }], steps: [
    { category: 'expect', title: secret, error: { message: secret, name: secret }, location: { file: context.specPath, line: 2, column: 3 }, steps: [] },
    { category: 'pw:api', error: { message: secret }, location: { file: '/private/unknown.ts', line: 2, column: 3 } },
  ] }, context);
  assert.deepEqual(result, { title: 'safe source case', status: 'failed', errorKind: 'test_failed', failures: [{ kind: 'expectation_failed', file: SPEC_FILE, line: 2, column: 3 }] });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('/accepted'));
  assert.deepEqual(safeDiagnostics([result], context), [result]);
});
test('timeouts and direct assertions retain canonical kinds and only valid source coordinates', () => {
  assert.deepEqual(caseDiagnostic({ title: 'safe source case' }, { status: 'timedOut', errors: [{ location: { file: context.specPath, line: 2, column: 4 } }] }, context),
    { title: 'safe source case', status: 'timedOut', errorKind: 'timeout', failures: [{ kind: 'timeout', file: SPEC_FILE, line: 2, column: 4 }] });
  const result = caseDiagnostic({ title: 'private title' }, { status: 'private status', steps: [{ category: 'private category', error: { message: 'private' }, location: { file: context.specPath, line: 999, column: 1 } }] }, context);
  assert.deepEqual(result, { title: '(unrecognized case)', status: 'unknown', errorKind: 'test_failed', failures: [] });
});
test('upload validation drops injected fields and unknown error kinds, statuses, source files and titles', () => {
  assert.deepEqual(safeDiagnostics([{ title: 'private', status: 'private', errorKind: 'private', message: 'private' }], context), [{ title: '(unrecognized case)', status: 'unknown' }]);
  assert.deepEqual(safeDiagnostics([{ title: 'safe source case', status: 'failed', errorKind: 'test_failed', failures: [{ kind: 'private', file: '/private/file.ts', line: 1, column: 1, message: 'private' }] }], context),
    [{ title: 'safe source case', status: 'failed', errorKind: 'test_failed', failures: [{ kind: 'test_failed' }] }]);
});
