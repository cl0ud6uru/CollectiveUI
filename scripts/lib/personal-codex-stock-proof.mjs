import { MASK_STATES, CASE_CHECKS, maskCommands } from './personal-codex-mask-proof.mjs';
export { MASK_STATES, passedProbe } from './personal-codex-mask-proof.mjs';

export const STOCK_CASE_CHECKS = CASE_CHECKS.filter(name => name !== 'kernelPathsDenied')
  .concat(['processIsolation', 'shadowWriteIntegrity', 'gitExecution', 'stockArtifactsMatch', 'defaultMetadataReadOnly']);

export function allStockChecksPass(cases) {
  return MASK_STATES.every(state => cases[state] && STOCK_CASE_CHECKS.every(name => cases[state][name] === true)
    && Object.values(cases[state]).every(value => value === true));
}

const program = (name, body) => `
const fs = require('node:fs');
const deny = action => {
  try { action(); } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(error.code)) return;
    throw error;
  }
  throw new Error('Protected operation succeeded.');
};
${body}
process.stdout.write(JSON.stringify({ probe: ${JSON.stringify(name)}, passed: true }));`;

// The same three listening services must be reachable outside the tool sandbox.
// Then direct TCP, UDP and a filesystem Unix socket must all fail inside it,
// including with proxy environment variables cleared. Timeouts cannot pass.
export function networkCommand(denied = true) {
  return `
const net = require('node:net'), dgram = require('node:dgram');
for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete process.env[name];
const deniedCodes = ['EACCES','EPERM','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH'];
const expectDenied = ${JSON.stringify(denied)};
const tcp = options => new Promise((resolve, reject) => {
  const socket = net.connect(options);
  socket.on('connect', () => { socket.destroy(); expectDenied ? reject(new Error('Network bypass succeeded.')) : resolve(); });
  socket.on('error', error => expectDenied && deniedCodes.includes(error.code) ? resolve() : reject(error));
});
const udp = () => new Promise((resolve, reject) => {
  let socket;
  const failure = error => { try { socket?.close(); } catch { /* A denied bind may leave it unstarted. */ } expectDenied && deniedCodes.includes(error.code) ? resolve() : reject(error); };
  try { socket = dgram.createSocket('udp4'); } catch (error) { failure(error); return; }
  socket.on('error', failure);
  socket.on('message', bytes => { socket.close(); !expectDenied && bytes.toString()==='fixture-udp-control' ? resolve() : reject(new Error('UDP bypass succeeded.')); });
  try { socket.send(Buffer.from('fixture'), 4501, '127.0.0.1', error => { if(error) failure(error); }); } catch(error) { failure(error); }
});
Promise.all([tcp({port:4500,host:'127.0.0.1'}), tcp({path:'/home/agent/workspace/fixture-network.sock'}), udp()])
 .then(()=>{process.stdout.write(JSON.stringify({probe: expectDenied ? 'nativeNetworkDenied' : 'networkControlReachable', passed:true}));process.exit(0);})
 .catch(()=>process.exit(1));
setTimeout(()=>process.exit(2),2500);`;
}

export function stockCommands(state) {
  const commands = maskCommands(state);
  // The synthetic helper ancestors are visible; original home siblings are absent.
  const privatePaths = ['auth.json', 'config.toml', 'history.jsonl', 'sessions/fixture.json',
    'archived_sessions/fixture.json', 'log/fixture.txt', 'logs/fixture.txt'];
  commands.homeReadDenied = program('homeReadDenied', `
if (fs.readdirSync('/codex-home').includes('unknown-sibling.txt')) throw new Error('Original home listing exposed.');
for (const path of ${JSON.stringify([...privatePaths, 'unknown-sibling.txt'])}) deny(() => fs.readFileSync('/codex-home/' + path));`);
  // Known secret masks deny writes. Unlisted paths can be private shadow writes;
  // the independently executed backing-data check is mandatory for acceptance.
  commands.homeWriteDenied = program('homeWriteDenied', `
for (const path of ${JSON.stringify(privatePaths)}) deny(() => fs.writeFileSync('/codex-home/' + path, 'fixture-overwrite'));`);
  commands.metadataProtected = maskCommands(state === 'missing' ? 'empty' : state).metadataProtected;
  commands.defaultMetadataReadOnly = program('defaultMetadataReadOnly', `
for (const name of ['.git', '.agents']) {
  const root = '/home/agent/workspace/' + name;
  if (fs.readFileSync(root + '/fixture.txt', 'utf8') !== 'fixture-public-metadata') throw new Error('Read-only metadata unavailable.');
  deny(() => fs.writeFileSync(root + '/fixture.txt', 'fixture-overwrite'));
  deny(() => fs.writeFileSync(root + '/new-fixture.txt', 'fixture-overwrite'));
  deny(() => fs.renameSync(root, root + '-renamed'));
}`);
  delete commands.kernelPathsDenied;
  commands.nativeNetworkDenied = networkCommand();
  commands.processIsolation = program('processIsolation', `
const parent = JSON.parse(fs.readFileSync('/home/agent/workspace/fixture-parent.json', 'utf8'));
if (fs.readlinkSync('/proc/self/ns/pid') === parent.pidNamespace) throw new Error('Parent PID namespace inherited.');
for (const path of ['environ', 'mem', 'root/codex-home/auth.json', 'cwd/auth.json', 'fd/' + parent.fd]) {
  deny(() => fs.readFileSync('/proc/' + parent.pid + '/' + path));
}
for (const path of ['/proc/self/root/codex-home/auth.json', '/proc/1/root/codex-home/auth.json']) deny(() => fs.readFileSync(path));
deny(() => fs.readdirSync('/sys'));
if (!fs.readFileSync('/proc/self/status', 'utf8').includes('Pid:')) throw new Error('Private procfs unavailable.');`);
  commands.shadowWriteIntegrity = program('shadowWriteIntegrity', `
try {
  fs.writeFileSync('/codex-home/unknown-sibling.txt', 'fixture-private-shadow');
  if (fs.readFileSync('/codex-home/unknown-sibling.txt', 'utf8') !== 'fixture-private-shadow') throw new Error('Unexpected shadow contents.');
} catch (error) { if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }`);
  commands.gitExecution = program('gitExecution', `
const cp = require('node:child_process');
const root = fs.mkdtempSync('/home/agent/workspace/git-fixture-');
for (const args of [['init', '-q', root], ['-C', root, 'status', '--porcelain']]) {
  const result = cp.spawnSync('git', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0 || result.stderr) throw new Error('Git execution failed.');
}
const python = cp.spawnSync('python3', ['-c', 'print("fixture-python")'], { encoding: 'utf8' });
if (python.error || python.status !== 0 || python.stdout.trim() !== 'fixture-python') throw new Error('Python execution failed.');`);
  return commands;
}
