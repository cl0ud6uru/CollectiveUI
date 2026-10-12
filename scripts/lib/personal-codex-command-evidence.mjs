import { passedProbe } from './personal-codex-mask-proof.mjs';
import { FIXTURE_REDACTION_RULES, redactFixtureText } from './personal-codex-fixture-rpc.mjs';

export const COMMAND_EVIDENCE_LIMIT = 4096;
const text = value => redactFixtureText(value).slice(0, COMMAND_EVIDENCE_LIMIT);
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const sensitive = /^(access_?token|refresh_?token|id_?token|api_?key|authorization)$/i;
function project(value, depth = 0) {
  if (typeof value === 'string') return text(value);
  if (value === null || typeof value !== 'object') return value ?? null;
  if (depth >= 4) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 16).map(item => project(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 16).map(([key, field]) =>
    [text(key), sensitive.test(key) ? '[redacted]' : project(field, depth + 1)]));
}

/** Synthetic fixture replies only. Acceptance is delegated to the unchanged validator. */
export function commandEvidence(reply, expectedProbe) {
  const result = reply?.result;
  let proof, parseError;
  try { proof = JSON.parse(result?.stdout); } catch (error) { parseError = text(error.message); }
  const keys = proof !== null && typeof proof === 'object' ? Object.keys(proof) : [];
  const mismatches = [];
  if (reply?.error) mismatches.push('rpc-error');
  if (!result || typeof result !== 'object') mismatches.push('result-missing');
  if (result?.exitCode !== 0) mismatches.push('exit-code-not-zero');
  if (result?.stderr !== '') mismatches.push('stderr-not-empty');
  if (parseError) mismatches.push('stdout-json-invalid');
  else {
    if (valueType(proof) !== 'object') mismatches.push('proof-not-object');
    if (proof?.probe !== expectedProbe) mismatches.push('probe-name-mismatch');
    if (proof?.passed !== true) mismatches.push('passed-not-true');
    if (keys.sort().join() !== 'passed,probe') mismatches.push('proof-keys-mismatch');
  }
  const traces = [];
  for (const line of String(result?.stderr ?? '').split('\n')) {
    if (!line.startsWith('COLLECTIVE_FIXTURE_TRACE:')) continue;
    try { traces.push(project(JSON.parse(line.slice('COLLECTIVE_FIXTURE_TRACE:'.length)))); }
    catch { traces.push({ parseError: 'Fixture trace was incomplete or malformed.' }); }
  }
  return { passed: passedProbe(reply, expectedProbe), expected: { exitCode: 0, stderr: '', proof: { probe: expectedProbe, passed: true }, proofKeys: ['passed', 'probe'] },
    actual: { rpcError: project(reply?.error), exitCode: project(result?.exitCode), exitCodeType: valueType(result?.exitCode),
      stdout: text(result?.stdout), stdoutType: valueType(result?.stdout), stdoutTruncated: redactFixtureText(result?.stdout).length > COMMAND_EVIDENCE_LIMIT,
      stderr: text(result?.stderr), stderrType: valueType(result?.stderr), stderrTruncated: redactFixtureText(result?.stderr).length > COMMAND_EVIDENCE_LIMIT,
      proof: parseError ? { parsed: false, parseError } : { parsed: true, type: valueType(proof), keys: project(keys), keyCount: keys.length, fields: project(proof),
        projectionLimits: { depth: 4, arrayItems: 16, objectFields: 16, textCharacters: COMMAND_EVIDENCE_LIMIT } },
      operationTraces: traces.slice(0, 4) }, mismatches };
}

/** Append, never replace, failures across all metadata states and run phases. */
export function collectCommandEvidence(failures, state, context, reply, expectedProbe = context.check) {
  const observation = commandEvidence(reply, expectedProbe);
  if (!observation.passed) {
    failures[state] ??= [];
    failures[state].push({ ...context, ...observation });
  }
  return observation.passed;
}

/** Observe operations without replacing the script, assertions or exception behavior.
 * Emit only on an uncaught failure; successful proof stdout/stderr remain untouched.
 */
export function traceFixtureCommand(script, probe) {
  return `
const stripVTControlCharacters = require('node:util').stripVTControlCharacters;
const fixtureRedactionRules = ${JSON.stringify(FIXTURE_REDACTION_RULES)};
const fixtureRedact = value => {
  const plain = Array.from(stripVTControlCharacters(String(value??'')))
    .filter(char=>char==='\\n'||char==='\\t'||(char.codePointAt(0)>=32&&char.codePointAt(0)!==127)).join('');
  return fixtureRedactionRules.reduce((text,rule)=>text.replace(new RegExp(rule.source,rule.flags),rule.replacement),plain);
};
const fixtureText = value => fixtureRedact(value).slice(0, 1024);
const fixtureFs = require('node:fs'), fixtureCp = require('node:child_process');
const fixtureCrypto = require('node:crypto');
const fixtureOperations = [], fixtureSubprocesses = [];
let fixturePidNamespace;
for (const key of ['readFileSync','writeFileSync','readdirSync','mkdirSync','renameSync','unlinkSync','rmdirSync','readlinkSync','symlinkSync','mkdtempSync']) {
  const original = fixtureFs[key];
  fixtureFs[key] = function(...args) {
    const operation = { operation:key, paths:args.slice(0,key==='renameSync'||key==='symlinkSync'?2:1).map(path=>fixtureText(path)), outcome:'started' };
    fixtureOperations.push(operation); if(fixtureOperations.length>8)fixtureOperations.shift();
    if(key==='readlinkSync'&&String(args[0])==='/proc/self/ns/pid')fixturePidNamespace=operation;
    try {
      const result=original.apply(this,args);operation.outcome='returned';
      try {
        if(key==='readlinkSync')operation.value=fixtureText(result);
        if(key==='readFileSync'){operation.bytes=Buffer.byteLength(result);operation.sha256=fixtureCrypto.createHash('sha256').update(result).digest('hex');}
      } catch { operation.observationIncomplete=true; }
      return result;
    }
    catch(error) {operation.outcome='threw';operation.error={code:error.code??null,syscall:error.syscall??null,message:fixtureText(error.message)};throw error;}
  };
}
const fixtureSpawn = fixtureCp.spawnSync;
fixtureCp.spawnSync = function(command,args,options) {
  const result = fixtureSpawn.call(this,command,args,options);
  fixtureSubprocesses.push({command:fixtureText(command),args:(args??[]).slice(0,8).map(arg=>fixtureText(arg)),status:result.status,signal:result.signal,
    error:result.error?{code:result.error.code??null,message:fixtureText(result.error.message)}:null,stdout:fixtureText(result.stdout??''),stderr:fixtureText(result.stderr??'')});
  if(fixtureSubprocesses.length>4)fixtureSubprocesses.shift();return result;
};
process.on('uncaughtExceptionMonitor', error => {
  try {
    process.stderr.write('COLLECTIVE_FIXTURE_TRACE:'+JSON.stringify({probe:${JSON.stringify(probe)},error:{name:error.name,code:error.code??null,message:fixtureText(error.message)},filesystem:fixtureOperations,subprocesses:fixtureSubprocesses,
      pidNamespace:fixturePidNamespace??null,pathEntries:(process.env.PATH??'').split(':').slice(0,16).map(path=>fixtureText(path))})+'\\n');
  } catch { /* Observation must not replace the original uncaught exception. */ }
});
${script}`;
}
