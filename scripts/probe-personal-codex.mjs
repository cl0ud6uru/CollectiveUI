import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sandboxPolicy, dockerExecutable } from '../src/personal-codex/sandbox-policy.mjs';
import { fixtureRpc, fixtureFailure } from './lib/personal-codex-fixture-rpc.mjs';

const executable = dockerExecutable(process.env.PERSONAL_CODEX_DOCKER_EXECUTABLE);
const policy = await sandboxPolicy(process.env.PERSONAL_CODEX_SANDBOX_PROFILE);
const security = policy.create.flatMap(opt => ['--security-opt', opt]);
const dockerEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' };

// Isolated, disposable fixtures only. The native grant is never populated and the network is none.
const image = process.env.PERSONAL_CODEX_NATIVE_IMAGE ?? 'collectiveui/personal-codex:stock-runtime';
if (!/^collectiveui\/personal-codex(?::[a-z0-9-]+|@sha256:[a-f0-9]{64})$/.test(image)) throw new Error('Reviewed personal Codex fixture image required.');
const name = `cui-codex-probe-${randomUUID()}`, home = `${name}-home`, workspace = `${name}-workspace`;
const docker = (args) => execFileSync(executable, args, { encoding: 'utf8', timeout: 30000, env: dockerEnv });
const common = ['--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...security,
  '--user', '10001:10001', '--pids-limit', '256', '--memory', '2048m', '--memory-swap', '2048m', '--cpus', '2',
  '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--mount', `type=volume,src=${home},dst=/codex-home`,
  '--mount', `type=volume,src=${workspace},dst=/home/agent/workspace`, '--env', 'NODE_VERSION', '--env', 'YARN_VERSION',
  '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home', '--workdir', '/home/agent/workspace'];
let child, rpc, removed = false;
let stage = 'volumeCreate';
const evidence = { version: '0.163.0-alpha.2', authenticated: false, verified: false, checks: {} };
try {
  docker(['volume', 'create', home]); docker(['volume', 'create', workspace]);
  stage = 'fixtureSetup';
  docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...security,
    '--user', '10001:10001', '--mount', `type=volume,src=${home},dst=/codex-home`, '--mount', `type=volume,src=${workspace},dst=/home/agent/workspace`,
    image, 'sh', '-c', 'printf fixture-private-auth-sentinel > /codex-home/auth.json; printf retained-workspace-sentinel > /home/agent/workspace/retained.txt']);
  child = spawn(executable, ['run', '-i', ...common, image, 'node', '/opt/collective-codex/server.mjs', '--stdio'], { stdio: 'pipe', env: dockerEnv });
  rpc = fixtureRpc(child);
  const { request, notify } = rpc;
  stage = 'initial.initialize';
  const initialized = await request('initialize', { clientInfo: { name: 'collective_probe', version: 'fixture' }, capabilities: { experimentalApi: true } });
  evidence.checks.protocolVersion = initialized.result?.userAgent?.includes('/0.163.0-alpha.2 ') === true;
  if (!evidence.checks.protocolVersion) throw new Error(initialized.error?.message ?? 'Fixture protocol version mismatch.');
  if (!notify('initialized')) throw new Error('Fixture process unavailable after initialize.');
  stage = 'containerInspection';
  const [container] = JSON.parse(docker(['inspect', name]));
  evidence.checks.sandboxPolicyMatches = JSON.stringify(container.HostConfig.SecurityOpt) === JSON.stringify(policy.inspect) && container.AppArmorProfile === (policy.appArmorProfile ?? 'docker-default');
  stage = 'initial.managedRequirements';
  const nativePolicy = await request('configRequirements/read', {});
  evidence.checks.managedPolicy = nativePolicy.result?.requirements?.defaultPermissions === 'collective-personal' && nativePolicy.result.requirements.allowedLoginMethods?.join() === 'chatgpt';
  if (!evidence.checks.managedPolicy) throw new Error(nativePolicy.error?.message ?? 'Fixture managed policy mismatch.');
  const exec = command => request('command/exec', { command, cwd: '/home/agent/workspace', permissionProfile: 'collective-personal', timeoutMs: 5000, outputBytesCap: 2048 });
  stage = 'nativeWorkspaceExecution';
  const write = await exec(['sh', '-c', 'printf native-write-sentinel > /home/agent/workspace/native.txt && cat /home/agent/workspace/native.txt']);
  evidence.checks.nativeWorkspaceExecution = write.result?.exitCode === 0 && write.result.stdout === 'native-write-sentinel';
  if (!evidence.checks.nativeWorkspaceExecution) {
    evidence.failure = fixtureFailure(new Error(write.error?.message ?? write.result?.stderr ?? 'Native command unavailable.'), stage, rpc.snapshot());
    evidence.blocker = /namespace/.test(write.result?.stderr ?? '') ? 'The host/container cannot create the unprivileged namespace required by bubblewrap.' : 'Native workspace execution failed; runtime cannot be activated.';
  } else {
    stage = 'nativeProtectionAndNetwork';
    const denied = await exec(['sh', '-c', 'cat /codex-home/auth.json /proc/1/root/codex-home/auth.json']);
    evidence.checks.protectedReadDenied = !!denied.result && typeof denied.result.exitCode === 'number' && denied.result.exitCode !== 0 && !denied.result.stdout.includes('fixture-private-auth-sentinel');
    const symlink = await exec(['sh', '-c', 'ln -s /codex-home/auth.json /home/agent/workspace/auth-link && cat /home/agent/workspace/auth-link']);
    evidence.checks.symlinkReadDenied = !!symlink.result && typeof symlink.result.exitCode === 'number' && symlink.result.exitCode !== 0 && !symlink.result.stdout.includes('fixture-private-auth-sentinel');
    // A listening positive control is essential: an absent server cannot prove a sandbox denial.
    docker(['exec', '-d', name, 'node', '-e', 'require("node:net").createServer(s=>s.end("fixture-network-control")).listen(4500,"127.0.0.1")']);
    const connect = 'const net=require("node:net");let attempts=0;const probe=()=>{const s=net.connect(4500,"127.0.0.1");s.on("connect",()=>{s.destroy();console.log("fixture-network-reachable");process.exit(0)});s.on("error",()=>{if(++attempts<20)setTimeout(probe,50);else process.exit(1)});};probe();setTimeout(()=>process.exit(1),3000)';
    evidence.checks.networkControlReachable = docker(['exec', name, 'node', '-e', connect]).trim() === 'fixture-network-reachable';
    const network = await exec(['node', '-e', 'const net=require("node:net");const s=net.connect(4500,"127.0.0.1");s.on("connect",()=>process.exit(1));s.on("error",()=>{console.log("network-denied");process.exit(0)});setTimeout(()=>process.exit(2),2000)']);
    evidence.checks.nativeNetworkDenied = evidence.checks.networkControlReachable && network.result?.exitCode === 0 && network.result.stdout.trim() === 'network-denied';
  }
  stage = 'replacementStorage';
  child.stdin.end(); docker(['stop', name]); docker(['rm', name]); removed = true;
  // Container replacement reuses the exact fixture volumes; credentials/history volume is separate.
  const retained = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...security, '--user', '10001:10001',
    '--mount', `type=volume,src=${home},dst=/codex-home`, '--mount', `type=volume,src=${workspace},dst=/home/agent/workspace`, image, 'sh', '-c', 'cat /home/agent/workspace/retained.txt; cat /codex-home/auth.json']);
  evidence.checks.storageSurvivesReplacement = retained === 'retained-workspace-sentinelfixture-private-auth-sentinel';
  if (evidence.checks.nativeWorkspaceExecution) evidence.checks.nativeFileSurvivesReplacement = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', ...security, '--user', '10001:10001',
    '--mount', `type=volume,src=${workspace},dst=/home/agent/workspace`, image, 'cat', '/home/agent/workspace/native.txt']) === 'native-write-sentinel';
  evidence.verified = ['sandboxPolicyMatches', 'protocolVersion', 'managedPolicy', 'nativeWorkspaceExecution', 'protectedReadDenied', 'symlinkReadDenied', 'networkControlReachable', 'nativeNetworkDenied', 'storageSurvivesReplacement', 'nativeFileSurvivesReplacement'].every(key => evidence.checks[key] === true);
} catch (error) {
  const failure = fixtureFailure(error, stage, rpc?.snapshot());
  if (evidence.failure) evidence.secondaryFailure = failure;
  else evidence.failure = failure;
  evidence.blocker = 'Native fixture setup or execution failed; no live account was used.';
}
finally {
  child?.kill();
  try { if (!removed) docker(['rm', '-f', name]); } catch { /* only this disposable probe container */ }
  for (const volume of [home, workspace]) { try { docker(['volume', 'rm', volume]); } catch { /* only volumes created above */ } }
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.verified) process.exitCode = 1;
}
