import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixtureRpc, fixtureFailure } from './lib/personal-codex-fixture-rpc.mjs';
import { isReviewedFixtureImage } from './lib/personal-codex-fixture-image.mjs';
import { sandboxPolicy, dockerExecutable } from '../src/personal-codex/sandbox-policy.mjs';
import { SIWC_NODE_EXECUTABLE, siwcToolCommand, siwcToolEvidence, siwcAppServerObservation, passedSiwcAppServerObservation,
  siwcSocketPositiveControl } from './lib/personal-codex-siwc-proof.mjs';

// Operator-only disposable proof. No accounts, enrollments, grants, host mounts,
// published ports, security-policy changes, or authenticated model requests.
const image = process.env.PERSONAL_CODEX_NATIVE_IMAGE ?? 'collectiveui/personal-codex:stock-runtime';
const tokenNonce = randomUUID(), toolNonce = randomUUID();
const sentinel = 'fixture-only-siwc-' + tokenNonce;
const name = 'cui-codex-siwc-' + randomUUID(), home = name + '-home', workspace = name + '-workspace';
const dockerEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' };
const evidence = { version: '0.163.0-alpha.2', authenticated: false, verified: false,
  artifacts: { requestedImage: image, sandboxProfile: process.env.PERSONAL_CODEX_SANDBOX_PROFILE ?? 'default-docker' }, checks: {}, observations: {} };
const checks = evidence.checks, volumes = [];
let dockerPath, runtime, stage = 'fixtureInputsOrPolicy', containerRequested = false, synced = false, cleared = false;
const docker = (args, input) => execFileSync(dockerPath, args, { encoding: 'utf8', timeout: 30000,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }), env: dockerEnv });
const outside = script => JSON.parse(docker(['exec', name, 'node', '-e', script]));
const digest = path => createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex');

try {
  if (!isReviewedFixtureImage(image)) throw new Error('Unreviewed fixture image.');
  dockerPath = dockerExecutable(process.env.PERSONAL_CODEX_DOCKER_EXECUTABLE);
  const security = await sandboxPolicy(process.env.PERSONAL_CODEX_SANDBOX_PROFILE);
  evidence.artifacts.probeSha256 = digest('./probe-personal-codex-siwc.mjs');
  evidence.artifacts.siwcProofSha256 = digest('./lib/personal-codex-siwc-proof.mjs');
  const sources = {
    '/opt/collective-codex/server.mjs': digest('../docker/personal-codex/server.mjs'),
    '/opt/collective-codex/bridge.mjs': digest('../docker/personal-codex/bridge.mjs'),
    '/opt/collective-codex/prepare-workspace.mjs': digest('../docker/personal-codex/prepare-workspace.mjs'),
    '/etc/codex/requirements.toml': digest('../docker/personal-codex/requirements.toml'),
  };
  evidence.artifacts.sourceSha256 = sources;
  const lock = JSON.parse(readFileSync(new URL('../docker/personal-codex/stock-inputs.lock.json', import.meta.url)));
  const base = ['--network', 'none', '--read-only', '--cap-drop', 'ALL',
    ...security.create.flatMap(value => ['--security-opt', value]), '--user', '10001:10001',
    '--pids-limit', '256', '--memory', '2048m', '--memory-swap', '2048m', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', 'type=volume,src=' + home + ',dst=/codex-home',
    '--mount', 'type=volume,src=' + workspace + ',dst=/home/agent/workspace',
    '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home', '--workdir', '/home/agent/workspace'];
  stage = 'volumeCreate';
  for (const volume of [home, workspace]) { docker(['volume', 'create', volume]); volumes.push(volume); }
  stage = 'normalWrapperStart'; containerRequested = true;
  docker(['run', '-d', '--name', name, ...base, image, 'node', '/opt/collective-codex/server.mjs']);
  stage = 'containerBoundary';
  const inspected = JSON.parse(docker(['inspect', name]))[0];
  evidence.artifacts.imageId = inspected.Image;
  checks.containerBoundary = inspected.Config.User === '10001:10001' && inspected.HostConfig.NetworkMode === 'none'
    && inspected.HostConfig.ReadonlyRootfs === true && inspected.HostConfig.Privileged === false
    && inspected.HostConfig.CapDrop?.join() === 'ALL' && !inspected.HostConfig.CapAdd?.length
    && ['PidMode','IpcMode','UTSMode','UsernsMode'].every(key => inspected.HostConfig[key] !== 'host')
    && JSON.stringify([...inspected.HostConfig.SecurityOpt].sort()) === JSON.stringify([...security.inspect].sort())
    && (!security.appArmorProfile || inspected.AppArmorProfile === security.appArmorProfile)
    && inspected.Mounts.length === 2 && inspected.Mounts.every(mount => mount.Type === 'volume' && mount.RW === true
      && ((mount.Name === home && mount.Destination === '/codex-home') || (mount.Name === workspace && mount.Destination === '/home/agent/workspace')))
    && /^sha256:[a-f0-9]{64}$/.test(inspected.Image) && (!image.startsWith('sha256:') || inspected.Image === image);
  requireCheck('containerBoundary');
  stage = 'reviewedArtifacts';
  checks.reviewedArtifacts = outside(`const fs=require('node:fs'),crypto=require('node:crypto');const expected=${JSON.stringify({ ...sources,
    '/opt/codex/bin/codex': lock.nativeSha256, '/opt/codex/codex-resources/bwrap': lock.bundledBubblewrapSha256 })};
    process.stdout.write(JSON.stringify({matched:Object.entries(expected).every(([path,hash])=>crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')===hash)
      &&!fs.existsSync('/usr/bin/bwrap')&&!fs.existsSync('/usr/local/bin/bwrap')}));`).matched === true;
  requireCheck('reviewedArtifacts');
  stage = 'initialAppServer';
  const initial = await observeAppServer(false);
  evidence.observations.initialAppServer = initial;
  checks.initialAppServer = passedSiwcAppServerObservation(initial, false); requireCheck('initialAppServer');
  checks.initialSocketReachable = outside(siwcSocketPositiveControl()).connected === true; requireCheck('initialSocketReachable');
  stage = 'syncSyntheticToken';
  docker(['exec', '-i', name, 'node', '/opt/collective-codex/server.mjs', '--sync-token'],
    JSON.stringify({ accessToken: sentinel, credentialBinding: 'a'.repeat(64) }));
  synced = true;
  stage = 'tokenBearingAppServerPositiveControl';
  const bearing = await observeAppServer(true, initial.appServerPid);
  evidence.observations.tokenBearingAppServer = bearing;
  checks.tokenBearingAppServer = passedSiwcAppServerObservation(bearing, true, initial.appServerPid); requireCheck('tokenBearingAppServer');
  checks.tokenSocketReachableBefore = outside(siwcSocketPositiveControl()).connected === true; requireCheck('tokenSocketReachableBefore');
  stage = 'normalBridgeInitialize';
  const child = spawn(dockerPath, ['exec', '-i', name, 'node', '/opt/collective-codex/bridge.mjs'], { stdio: 'pipe', env: dockerEnv });
  runtime = { child, ...fixtureRpc(child) };
  const initialized = await runtime.request('initialize', { clientInfo: { name: 'collective_siwc_probe', version: 'fixture' }, capabilities: { experimentalApi: true } });
  checks.protocolVersion = initialized.result?.userAgent?.includes('/0.163.0-alpha.2 ') === true;
  requireCheck('protocolVersion');
  if (!runtime.notify('initialized')) throw new Error('Normal app-server bridge unavailable.');
  stage = 'managedRequirements';
  const policy = await runtime.request('configRequirements/read', {});
  checks.managedPolicy = policy.result?.requirements?.defaultPermissions === 'collective-personal'
    && policy.result.requirements.allowedLoginMethods?.join() === 'chatgpt';
  requireCheck('managedPolicy');
  stage = 'nativeParentAndChildIsolation';
  const command = siwcToolCommand(toolNonce, bearing.appServerPid);
  evidence.artifacts.commandSha256 = createHash('sha256').update(command).digest('hex');
  const reply = await runtime.request('command/exec', { command: [SIWC_NODE_EXECUTABLE,'-e',command], cwd: '/home/agent/workspace',
    permissionProfile: 'collective-personal', timeoutMs: 7000, outputBytesCap: 16384 });
  const proof = siwcToolEvidence(reply, toolNonce);
  evidence.observations.nativeCommand = proof;
  checks.nativeParentAndChildIsolation = proof.passed;
  // Recheck controls while the same token-bearing app-server remains alive.
  stage = 'positiveControlsAfterNativeCommand';
  const after = outside(siwcAppServerObservation(tokenNonce));
  evidence.observations.tokenBearingAppServerAfter = after;
  checks.tokenBearingAppServerRetained = passedSiwcAppServerObservation(after, true) && after.appServerPid === bearing.appServerPid;
  checks.tokenSocketReachableAfter = outside(siwcSocketPositiveControl()).connected === true;
  stage = 'clearSyntheticToken';
  runtime.child.stdin.end(); runtime.child.kill(); runtime = undefined;
  docker(['exec', name, 'node', '/opt/collective-codex/server.mjs', '--clear-token']); cleared = true;
  const clearObservation = await observeAppServer(false, bearing.appServerPid);
  evidence.observations.clearedAppServer = clearObservation;
  checks.sentinelClearedAndAppServerRestarted = passedSiwcAppServerObservation(clearObservation, false, bearing.appServerPid);
  checks.clearedSocketReachable = outside(siwcSocketPositiveControl()).connected === true;
} catch (error) {
  evidence.failure = safeFailure(error, stage);
} finally {
  runtime?.child.stdin.end(); runtime?.child.kill();
  if (synced && !cleared) {
    try { docker(['exec', name, 'node', '/opt/collective-codex/server.mjs', '--clear-token']); }
    catch { checks.failurePathTokenClear = false; }
  }
  checks.cleanupComplete = true;
  if (containerRequested) {
    try {
      if (docker(['container','ls','-a','--filter','name=^/' + name + '$','--format','{{.ID}}']).trim()) docker(['rm','-f',name]);
    } catch { checks.cleanupComplete = false; }
  }
  for (const volume of volumes) { try { docker(['volume','rm',volume]); } catch { checks.cleanupComplete = false; } }
  const required = ['containerBoundary','reviewedArtifacts','initialAppServer','initialSocketReachable','tokenBearingAppServer',
    'tokenSocketReachableBefore','protocolVersion','managedPolicy','nativeParentAndChildIsolation','tokenBearingAppServerRetained',
    'tokenSocketReachableAfter','sentinelClearedAndAppServerRestarted','clearedSocketReachable','cleanupComplete'];
  evidence.verified = !evidence.failure && required.every(key => checks[key] === true);
  if (!evidence.verified) evidence.blocker = 'Synthetic SIWC runtime proof incomplete or failed. Keep siwcSandboxVerified=false; the protected-mask proof is also required.';
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.verified) process.exitCode = 1;
}

function requireCheck(key) { if (checks[key] !== true) throw new Error('Required synthetic SIWC check failed: ' + key); }
async function observeAppServer(present, previousPid) {
  let observed;
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = outside(siwcAppServerObservation(tokenNonce));
    if (passedSiwcAppServerObservation(observed, present, previousPid)) return observed;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return observed;
}
function safeFailure(error, phase) {
  const context = runtime?.snapshot() ?? {};
  const failure = fixtureFailure(error, phase, context);
  return JSON.parse(JSON.stringify(failure).replaceAll(sentinel, '[synthetic sentinel redacted]'));
}
