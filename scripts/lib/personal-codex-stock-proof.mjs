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
  // The stock bootstrap always materializes a directory. Structural errors on
  // that directory are not permission proof: meaningful child mutations below
  // must be denied, and the outer backing-data check remains mandatory.
  commands.metadataProtected = program('metadataProtected', `
const root = '/home/agent/workspace/.codex';
const denyRootOperation = (action, structuralCodes) => {
  try { action(); } catch (error) {
    if (['EACCES','EPERM','EROFS','ENOENT','ENOTDIR',...structuralCodes].includes(error.code)) return;
    throw error;
  }
  throw new Error('Protected root mutation succeeded.');
};
deny(() => fs.readdirSync(root));
${state === 'populated' ? "deny(() => fs.readFileSync(root + '/fixture.txt'));\ndeny(() => fs.writeFileSync(root + '/fixture.txt', 'fixture-overwrite'));" : ''}
deny(() => fs.writeFileSync(root + '/new-fixture.txt', 'fixture-overwrite'));
deny(() => fs.mkdirSync(root + '/new-fixture-directory'));
denyRootOperation(() => fs.writeFileSync(root, 'fixture-overwrite'), ['EISDIR']);
denyRootOperation(() => fs.mkdirSync(root), ['EEXIST']);
denyRootOperation(() => fs.renameSync(root, root + '-renamed'), ['EBUSY']);
denyRootOperation(() => fs.unlinkSync(root), ['EISDIR']);
denyRootOperation(() => fs.rmdirSync(root), ['EBUSY']);`);
  commands.defaultMetadataReadOnly = program('defaultMetadataReadOnly', `
for (const name of ['.git', '.agents']) {
  const root = '/home/agent/workspace/' + name;
  if (fs.readFileSync(root + '/fixture.txt', 'utf8') !== 'fixture-public-metadata') throw new Error('Read-only metadata unavailable.');
  deny(() => fs.writeFileSync(root + '/fixture.txt', 'fixture-overwrite'));
  deny(() => fs.writeFileSync(root + '/new-fixture.txt', 'fixture-overwrite'));
  try { fs.renameSync(root, root + '-renamed'); throw new Error('Protected metadata rename succeeded.'); }
  catch (error) { if (!['EACCES','EPERM','EROFS','ENOENT','ENOTDIR','EBUSY'].includes(error.code)) throw error; }
}`);
  // These no-input commands do not need a stdin socketpair. Restricted stock
  // seccomp denies shutdown(), which Node uses to close default piped stdin.
  // Keep rejecting every spawn error, even when a child also reports status0.
  // SIWC commands inherit no environment, including PATH. The stock sandbox
  // exposes only its active arg0 helper directory beneath this synthetic parent.
  // Require one exact alias to the pinned native binary; ambiguity cannot pass.
  const helper = `
const helperRoot = '/codex-home/tmp/arg0';
const helpers = fs.readdirSync(helperRoot).filter(name => /^codex-arg0[^/]+$/.test(name));
if (helpers.length !== 1) throw new Error('Active native helper missing or ambiguous.');
const dir = helperRoot + '/' + helpers[0];
if (!fs.lstatSync(dir + '/codex-linux-sandbox').isSymbolicLink()
  || fs.realpathSync(dir + '/codex-linux-sandbox') !== '/opt/codex/bin/codex') throw new Error('Active native helper alias changed.');`;
  commands.activeHelperExecution = program('activeHelperExecution', `${helper}
const result = require('node:child_process').spawnSync(dir + '/codex-linux-sandbox', ['--help'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
if (result.error || result.signal || result.status !== 0 || result.stderr !== '' || !result.stdout.includes('sandbox')) throw new Error('Active native helper execution failed.');`);
  commands.activeHelperReadOnly = program('activeHelperReadOnly', `${helper}
fs.readdirSync(dir);
deny(() => fs.writeFileSync(dir + '/new-fixture.txt', 'fixture-overwrite'));
deny(() => fs.readFileSync('/codex-home/auth.json'));`);
  delete commands.kernelPathsDenied;
  commands.nativeNetworkDenied = networkCommand();
  commands.processIsolation = program('processIsolation', `
const parent = JSON.parse(fs.readFileSync('/home/agent/workspace/fixture-parent.json', 'utf8'));
// Under :minimal, stock's no-proc fallback omits /proc entirely. The outer
// fixture must independently observe this live command's distinct PID namespace.
try { const namespace=fs.readlinkSync('/proc/self/ns/pid');if(!/^pid:\\[[1-9][0-9]*\\]$/.test(namespace)||namespace === parent.pidNamespace) throw new Error('Private PID namespace invalid or inherited.'); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
process.kill(process.pid, 0); // Positive control: signaling self is available.
for (const path of ['environ', 'mem', 'root/codex-home/auth.json', 'cwd/auth.json', 'fd/' + parent.fd]) {
  deny(() => fs.readFileSync('/proc/' + parent.pid + '/' + path));
}
for (const path of ['/proc/self/root/codex-home/auth.json', '/proc/1/root/codex-home/auth.json']) deny(() => fs.readFileSync(path));
deny(() => fs.readdirSync('/sys'));
try { if (!fs.readFileSync('/proc/self/status', 'utf8').includes('Pid:')) throw new Error('Private procfs invalid.'); }
catch(error) { if(error.code !== 'ENOENT') throw error; }`);
  commands.shadowWriteIntegrity = program('shadowWriteIntegrity', `
try {
  fs.writeFileSync('/codex-home/unknown-sibling.txt', 'fixture-private-shadow');
  if (fs.readFileSync('/codex-home/unknown-sibling.txt', 'utf8') !== 'fixture-private-shadow') throw new Error('Unexpected shadow contents.');
} catch (error) { if (!['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }`);
  commands.gitExecution = program('gitExecution', `
const cp = require('node:child_process');
const root = fs.mkdtempSync('/home/agent/workspace/git-fixture-');
for (const args of [['init', '-q', root], ['-C', root, 'status', '--porcelain']]) {
  const result = cp.spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
  if (result.error || result.status !== 0 || result.stderr || (args.includes('status') && result.stdout !== '')) throw new Error('Git execution failed.');
}
if(!fs.readFileSync(root + '/.git/HEAD','utf8').startsWith('ref: refs/heads/')) throw new Error('Git initialization did not create a repository.');
const python = cp.spawnSync('python3', ['-c', 'print("fixture-python")'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
if (python.error || python.status !== 0 || python.stdout.trim() !== 'fixture-python') throw new Error('Python execution failed.');`);
  return commands;
}
