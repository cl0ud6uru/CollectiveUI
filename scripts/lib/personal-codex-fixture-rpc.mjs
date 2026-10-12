import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';

const LIMIT = 4096;
export const FIXTURE_REDACTION_RULES = [
  { source: String.raw`("(?:access_?token|refresh_?token|id_?token|api_?key|authorization)"\s*:\s*")[^"]*("|$)`, flags: 'gi', replacement: '$1[redacted]$2' },
  { source: String.raw`\bBearer\s+[^\s"']+`, flags: 'gi', replacement: 'Bearer [redacted]' },
  { source: String.raw`\bsk-[a-zA-Z0-9_-]{6,}\b`, flags: 'g', replacement: '[redacted]' },
  { source: String.raw`\bOPENAI_API_KEY=[^\s"']+`, flags: 'g', replacement: 'OPENAI_API_KEY=[redacted]' },
];
export function redactFixtureText(value) {
  const plain = Array.from(stripVTControlCharacters(String(value ?? '')))
    .filter(char => char === '\n' || char === '\t' || (char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127))
    .join('');
  return FIXTURE_REDACTION_RULES.reduce((text, rule) => text.replace(new RegExp(rule.source, rule.flags), rule.replacement), plain);
}
const bounded = value => redactFixtureText(value).slice(-LIMIT);

/** Only for disposable fixtures with synthetic credentials, never production logs. */
export function fixtureRpc(child, { timeoutMs = 15000 } = {}) {
  let next = 0, ended = false, exitCode = null, signal = null, transportDiagnostic = '';
  let stderr = Buffer.alloc(0);
  const pending = new Map();
  const snapshot = () => ({ processClosed: ended, processExitCode: exitCode, processSignal: signal,
    startupStderr: bounded(stderr.toString('utf8')), transportDiagnostic: bounded(transportDiagnostic) });
  child.stderr.on('data', bytes => { stderr = Buffer.concat([stderr, bytes]).subarray(-LIMIT); });
  createInterface({ input: child.stdout }).on('line', line => {
    let message; try { message = JSON.parse(line); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message);
  });
  function finish(message) {
    ended = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve({ error: { message } }); }
    pending.clear();
  }
  child.on('error', error => { transportDiagnostic = error.message; finish('Fixture process unavailable.'); });
  child.on('close', (code, processSignal) => { exitCode = code; signal = processSignal; finish('Fixture process exited before its RPC reply.'); });
  // A fatal bootstrap can close stdin before its final stderr/close event. Stop
  // new requests immediately, but let close drain stderr before pending replies
  // resolve. A live process with broken stdin is still bounded by the RPC timer.
  child.stdin.on('error', error => { transportDiagnostic = error.message; ended = true; });
  const notify = (method, params) => {
    if (ended || child.stdin.destroyed) return false;
    try { child.stdin.write(JSON.stringify({ method, ...(params === undefined ? {} : { params }) }) + '\n'); return true; }
    catch (error) { transportDiagnostic = error.message; finish('Fixture stdin unavailable.'); return false; }
  };
  const request = (method, params) => new Promise(resolve => {
    if (ended || child.stdin.destroyed) { resolve({ error: { message: 'Fixture process unavailable.' } }); return; }
    const id = ++next, timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: 'Fixture RPC timed out.' } }); }, timeoutMs);
    pending.set(id, { resolve, timer });
    try { child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); }
    catch (error) { transportDiagnostic = error.message; finish('Fixture stdin unavailable.'); }
  });
  return { request, notify, snapshot };
}

/** Keep the phase and bounded public-fixture stderr instead of a generic failure. */
export function fixtureFailure(error, stage, context = {}) {
  const diagnostic = bounded([error?.stderr?.toString(), error?.message, context.startupStderr, context.transportDiagnostic].filter(Boolean).join('\n'));
  return { stage, reason: /pivot_root|pivotroot/i.test(diagnostic) ? 'pivot-root-denied'
    : /namespace/i.test(diagnostic) ? 'unprivileged-namespace-unavailable'
    : /timed out/i.test(diagnostic) ? 'fixture-rpc-timeout'
    : context.processClosed ? 'fixture-process-exited' : 'fixture-operation-failed',
  operationExitCode: error?.status ?? null, ...context, diagnostic };
}
