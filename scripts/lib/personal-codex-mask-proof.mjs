// These are disposable fixture commands, never production credentials or policy overrides.
export const MASK_STATES = ['missing', 'empty', 'populated'];
export const CASE_CHECKS = ['protocolVersion', 'managedPolicy', 'requirementsMatch', 'containerBoundary',
  'nativeWorkspaceExecution', 'homeReadDenied', 'homeWriteDenied', 'metadataProtected',
  'symlinkReadDenied', 'kernelPathsDenied', 'activeHelperExecution', 'activeHelperReadOnly',
  'networkControlReachable', 'nativeNetworkDenied', 'backingDataUnchanged',
  'storageSurvivesReplacement', 'nativeFileSurvivesReplacement', 'replacementExecution',
  'metadataSymlinkFailsClosed', 'fixtureCompleted', 'cleanupComplete'];

export function passedProbe(reply, name) {
  if (reply?.error || reply?.result?.exitCode !== 0 || reply.result.stderr !== '') return false;
  try {
    const value = JSON.parse(reply.result.stdout);
    return value.probe === name && value.passed === true && Object.keys(value).sort().join() === 'passed,probe';
  } catch { return false; }
}

export function allMaskChecksPass(cases) {
  return MASK_STATES.every(state => cases[state] && CASE_CHECKS.every(name => cases[state][name] === true)
    && Object.values(cases[state]).every(value => value === true));
}

const program = (name, body) => `
const fs = require('node:fs');
const deny = action => {
  try { action(); } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR', 'EBUSY', 'EEXIST'].includes(error.code)) return;
    throw new Error('Unexpected protected-path failure.');
  }
  throw new Error('Protected operation succeeded.');
};
${body}
process.stdout.write(JSON.stringify({ probe: ${JSON.stringify(name)}, passed: true }));`;

export function maskCommands(state) {
  if (!MASK_STATES.includes(state)) throw new Error('Invalid fixture state.');
  const helper = `const dir = process.env.PATH.split(':').find(p => p.startsWith('/codex-home/tmp/arg0/codex-arg0') && !p.slice('/codex-home/tmp/arg0/'.length).includes('/'));
if (!dir) throw new Error('Active native helper missing.');`;
  return {
    nativeWorkspaceExecution: program('nativeWorkspaceExecution', `
fs.writeFileSync('/home/agent/workspace/native-${state}.txt', 'native-mask-fixture');
if (fs.readFileSync('/home/agent/workspace/native-${state}.txt', 'utf8') !== 'native-mask-fixture') throw new Error('Workspace execution failed.');`),
    homeReadDenied: program('homeReadDenied', `
deny(() => fs.readdirSync('/codex-home'));
for (const path of ['auth.json', 'config.toml', 'history.jsonl', 'sessions/fixture.json',
  'archived_sessions/fixture.json', 'log/fixture.txt', 'logs/fixture.txt', 'unknown-sibling.txt']) {
  deny(() => fs.readFileSync('/codex-home/' + path));
}`),
    homeWriteDenied: program('homeWriteDenied', `
for (const path of ['auth.json', 'config.toml', 'history.jsonl', 'sessions/fixture.json',
  'archived_sessions/fixture.json', 'log/fixture.txt', 'logs/fixture.txt', 'unknown-sibling.txt']) {
  deny(() => fs.writeFileSync('/codex-home/' + path, 'fixture-overwrite'));
}
deny(() => fs.mkdirSync('/codex-home/new-fixture-directory'));`),
    metadataProtected: program('metadataProtected', `
const root = '/home/agent/workspace/.codex';
${state === 'missing' ? `// A missing denied path can be represented by a synthetic empty file.
try { if (fs.readFileSync(root).length !== 0) throw new Error('Metadata contents exposed.'); }
catch (error) { if (!['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }` : 'deny(() => fs.readdirSync(root));'}
${state === 'populated' ? "deny(() => fs.readFileSync(root + '/fixture.txt'));" : ''}
deny(() => fs.writeFileSync(root, 'fixture-overwrite'));
deny(() => fs.writeFileSync(root + '/new-fixture.txt', 'fixture-overwrite'));
deny(() => fs.mkdirSync(root));
deny(() => fs.renameSync(root, root + '-renamed'));
deny(() => fs.unlinkSync(root));
deny(() => fs.rmdirSync(root));`),
    symlinkReadDenied: program('symlinkReadDenied', `
fs.symlinkSync('/codex-home/auth.json', '/home/agent/workspace/fixture-auth-link');
fs.symlinkSync('/codex-home/unknown-sibling.txt', '/home/agent/workspace/fixture-sibling-link');
deny(() => fs.readFileSync('/home/agent/workspace/fixture-auth-link'));
deny(() => fs.readFileSync('/home/agent/workspace/fixture-sibling-link'));`),
    kernelPathsDenied: program('kernelPathsDenied', `
deny(() => fs.readdirSync('/proc'));
deny(() => fs.readFileSync('/proc/self/environ'));
deny(() => fs.readdirSync('/sys'));`),
    activeHelperExecution: program('activeHelperExecution', `${helper}
const result = require('node:child_process').spawnSync(dir + '/codex-linux-sandbox', ['--help'], { encoding: 'utf8' });
if (result.error || result.status !== 0 || !result.stdout.includes('sandbox')) throw new Error('Active native helper execution failed.');`),
    activeHelperReadOnly: program('activeHelperReadOnly', `${helper}
fs.readdirSync(dir);
deny(() => fs.writeFileSync(dir + '/new-fixture.txt', 'fixture-overwrite'));
deny(() => fs.readFileSync('/codex-home/auth.json'));`),
    nativeNetworkDenied: `const net = require('node:net');
const socket = net.connect(4500, '127.0.0.1');
socket.on('connect', () => process.exit(1));
socket.on('error', error => {
  if (!['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EACCES', 'EPERM'].includes(error.code)) process.exit(2);
  process.stdout.write(JSON.stringify({ probe: 'nativeNetworkDenied', passed: true }));
  process.exit(0);
});
setTimeout(() => process.exit(2), 2000);`,
  };
}
