/** External reporter for the unmodified accepted spec. Never serialize Playwright error bodies. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const SPEC_FILE = 'tests/e2e/docker-hermes.spec.ts';
const statuses = new Set(['passed', 'failed', 'skipped', 'timedOut', 'interrupted']);
const kinds = new Set(['expectation_failed', 'browser_action_failed', 'hook_failed', 'test_failed', 'timeout']);
export function diagnosticContext(source, specPath) {
  return { specPath, lines: source.split('\n').length,
    titles: new Set([...source.matchAll(/^\s*test\('([^'\r\n]{1,200})',/gm)].map(match => match[1])) };
}
function location(value, context) {
  if (!value || typeof value.file !== 'string' || path.resolve(value.file) !== context.specPath ||
      !Number.isInteger(value.line) || value.line < 1 || value.line > context.lines ||
      !Number.isInteger(value.column) || value.column < 1 || value.column > 10000) return {};
  return { file: SPEC_FILE, line: value.line, column: value.column };
}
export function caseDiagnostic(test, result, context) {
  const failures = [];
  const visit = steps => {
    for (const step of Array.isArray(steps) ? steps : []) {
      if (step.error) {
        const kind = step.category === 'expect' ? 'expectation_failed' : step.category === 'pw:api'
          ? 'browser_action_failed' : step.category === 'hook' ? 'hook_failed' : 'test_failed';
        const item = { kind, ...location(step.location, context) };
        if (item.file && !failures.some(other => JSON.stringify(other) === JSON.stringify(item)) && failures.length < 10) failures.push(item);
      }
      visit(step.steps);
    }
  };
  visit(result.steps);
  const failed = !['passed', 'skipped'].includes(result.status);
  // error.location can identify a direct assertion that has no recorded step.
  if (failed && !failures.length) for (const error of result.errors ?? []) {
    const item = { kind: result.status === 'timedOut' ? 'timeout' : 'test_failed', ...location(error.location, context) };
    if (item.file && failures.length < 10) failures.push(item);
  }
  return { title: context.titles.has(test.title) ? test.title : '(unrecognized case)',
    status: statuses.has(result.status) ? result.status : 'unknown',
    ...(failed ? { errorKind: result.status === 'timedOut' ? 'timeout' : 'test_failed', failures } : {}) };
}
/** Validate again at the upload boundary; accept fixed enums and exact source locations only. */
export function safeDiagnostics(value, context) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map(item => ({
    title: context.titles.has(item?.title) ? item.title : '(unrecognized case)',
    status: statuses.has(item?.status) ? item.status : 'unknown',
    ...(kinds.has(item?.errorKind) ? { errorKind: item.errorKind, failures:
      (Array.isArray(item.failures) ? item.failures : []).slice(0, 10).map(failure => ({
        kind: kinds.has(failure?.kind) ? failure.kind : 'test_failed',
        ...location({ file: failure?.file === SPEC_FILE ? context.specPath : '', line: failure?.line, column: failure?.column }, context),
      })) } : {}),
  }));
}
export default class SanitizedBrowserReporter {
  records = [];
  onBegin() {
    const specPath = path.resolve(SPEC_FILE);
    this.context = diagnosticContext(readFileSync(specPath, 'utf8'), specPath);
  }
  onTestEnd(test, result) { this.records.push(caseDiagnostic(test, result, this.context)); }
  onEnd() {
    writeFileSync(process.env.ACCEPTANCE_DIAGNOSTICS_OUTPUT, JSON.stringify(safeDiagnostics(this.records, this.context)));
  }
}
