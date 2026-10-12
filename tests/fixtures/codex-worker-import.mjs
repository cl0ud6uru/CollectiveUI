import assert from 'node:assert/strict';

// Real plain-Node imports: no React server condition, Vitest mocks, database calls or native runtime.
const entries = [
  ['../../src/lib/codex/recovery.ts', ['stopCodexRun', 'reconcileCodexStops']],
  ['../../src/lib/codex/run.ts', ['runCodexTurn']],
  ['../../src/lib/codex/runtime.ts', ['callerRuntime', 'managedRuntimeForAccount']],
  ['../../src/lib/codex/client.ts', ['CodexClient']],
  ['../../src/personal-codex/accounts.ts', ['changeConnection', 'personalAccount']],
  ['../../src/personal-codex/approvals.ts', ['waitForApproval', 'decideApproval']],
  ['../../src/personal-codex/control.ts', ['personalControl']],
];
for (const [path, names] of entries) {
  const loaded = await import(path);
  for (const name of names) assert.equal(typeof loaded[name], 'function', `${path} must export ${name}`);
}
console.log('Codex recovery, dispatch, account and IPC modules import in the plain Node worker.');
