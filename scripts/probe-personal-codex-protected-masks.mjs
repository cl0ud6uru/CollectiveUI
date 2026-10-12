import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MASK_STATES, allStockChecksPass, stockCommands, passedProbe, networkCommand } from './lib/personal-codex-stock-proof.mjs';
import { fixtureRpc, fixtureFailure } from './lib/personal-codex-fixture-rpc.mjs';

// Disposable fixtures only. No enrollment/grants are read. Only synthetic command
// failures produce bounded diagnostics; production native logs stay suppressed.
const image = process.env.PERSONAL_CODEX_NATIVE_IMAGE ?? 'collectiveui/personal-codex:stock-runtime';
const dockerPath = process.env.PERSONAL_CODEX_DOCKER_EXECUTABLE ?? '/usr/local/bin/docker';
const evidence = { version: '0.163.0-alpha.2', authenticated: false, verified: false, cases: {} };
const requirementsSha256 = createHash('sha256').update(readFileSync(new URL('../docker/personal-codex/requirements.toml', import.meta.url))).digest('hex');
evidence.artifacts = { requestedImage: image, requirementsSha256,
  sandboxProfile: process.env.PERSONAL_CODEX_SANDBOX_PROFILE ?? 'default-docker', imageIds: {} };
const fixtureHome = {
  'auth.json': 'fixture-private-auth-sentinel',
  'config.toml': '# fixture-private-config-sentinel\n',
  'history.jsonl': 'fixture-private-history-sentinel',
  'sessions/fixture.json': 'fixture-private-session-sentinel',
  'archived_sessions/fixture.json': 'fixture-private-archive-sentinel',
  'log/fixture.txt': 'fixture-private-log-sentinel',
  'logs/fixture.txt': 'fixture-private-logs-sentinel',
  'unknown-sibling.txt': 'fixture-private-unknown-sibling-sentinel',
};
const docker = args => execFileSync(dockerPath, args, { encoding: 'utf8', timeout: 30000,
  stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' } });
let security = { create: ['no-new-privileges:true'], inspect: ['no-new-privileges:true'] };

try {
  if (!/^collectiveui\/personal-codex(?::[a-z0-9-]+|@sha256:[a-f0-9]{64})$/.test(image)
    || !['/usr/local/bin/docker', '/usr/bin/docker'].includes(dockerPath)) throw new Error('Unreviewed fixture input.');
  if (process.env.PERSONAL_CODEX_SANDBOX_PROFILE !== undefined) {
    // Operator commit 946723b supplies this fixed, hash-verified module.
    // Its absence is fatal; arbitrary security-opt and policy fallback are unavailable.
    const policy = await import('../src/personal-codex/sandbox-policy.mjs');
    security = await policy.sandboxPolicy(process.env.PERSONAL_CODEX_SANDBOX_PROFILE);
  }
  for (const state of MASK_STATES) await runCase(state);
  evidence.verified = allStockChecksPass(evidence.cases);
  if (!evidence.verified) evidence.blocker = 'The protected-path native gate is incomplete or failed. Activation remains blocked.';
} catch (error) {
  evidence.failure = fixtureFailure(error, 'fixtureInputsOrPolicy');
  evidence.blocker = 'Fixture setup or reviewed policy validation failed. No live account was used.';
} finally {
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.verified) process.exitCode = 1;
}

async function runCase(state) {
  const name = 'cui-codex-mask-' + randomUUID();
  const setupName = name + '-setup';
  const home = name + '-home', workspace = name + '-workspace';
  const checks = evidence.cases[state] = {};
  let runtime;
  let stage = 'volumeCreate';
  const base = ['--network', 'none', '--read-only', '--cap-drop', 'ALL',
    ...security.create.flatMap(value => ['--security-opt', value]), '--user', '10001:10001',
    '--pids-limit', '256', '--memory', '2048m', '--memory-swap', '2048m', '--cpus', '2',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--mount', 'type=volume,src=' + home + ',dst=/codex-home',
    '--mount', 'type=volume,src=' + workspace + ',dst=/home/agent/workspace',
    '--env', 'NODE_VERSION', '--env', 'YARN_VERSION', '--env', 'HOME=/codex-home', '--env', 'CODEX_HOME=/codex-home',
    '--workdir', '/home/agent/workspace'];
  const outside = script => docker(['exec', name, 'node', '-e', script]).trim();
  const verifyBacking = [
    "const fs=require('node:fs'); const files=" + JSON.stringify(fixtureHome) + ";",
    "for(const [path,value] of Object.entries(files)) if(fs.readFileSync('/codex-home/'+path,'utf8')!==value) process.exit(1);",
    "const root='/home/agent/workspace/.codex';",
    "if (!fs.existsSync(root)) process.exit(1);",
    "{ if(!fs.statSync(root).isDirectory()) process.exit(1); const expected=" + (state === 'populated' ? "['fixture.txt']" : '[]') + ";",
    "if(JSON.stringify(fs.readdirSync(root).sort())!==JSON.stringify(expected)) process.exit(1);",
    "if(" + JSON.stringify(state) + "==='populated' && fs.readFileSync(root+'/fixture.txt','utf8')!=='fixture-private-metadata-sentinel') process.exit(1); }",
    "if(fs.existsSync(root+'-renamed')) process.exit(1); process.stdout.write('backing-fixtures-retained');",
    "for(const name of ['.git','.agents']) { const path='/home/agent/workspace/'+name; if(fs.readFileSync(path+'/fixture.txt','utf8')!=='fixture-public-metadata' || fs.readdirSync(path).join()!=='fixture.txt' || fs.existsSync(path+'-renamed')) process.exit(1); }",
  ].join('\n');
  try {
    docker(['volume', 'create', home]); docker(['volume', 'create', workspace]);
    stage = 'fixtureSetup';
    docker(['run', '--rm', '--name', setupName, ...base, image, 'node', '-e', [
      "const fs=require('node:fs'),path=require('node:path');",
      "for(const [file,value] of Object.entries(" + JSON.stringify(fixtureHome) + ")) { const target='/codex-home/'+file;",
      "fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,value); }",
      "fs.writeFileSync('/home/agent/workspace/retained.txt','retained-workspace-sentinel');",
      "for(const name of ['.git','.agents']) { const path='/home/agent/workspace/'+name; fs.mkdirSync(path);fs.writeFileSync(path+'/fixture.txt','fixture-public-metadata'); }",
      "if(" + JSON.stringify(state) + "!=='missing') fs.mkdirSync('/home/agent/workspace/.codex');",
      "if(" + JSON.stringify(state) + "==='populated') fs.writeFileSync('/home/agent/workspace/.codex/fixture.txt','fixture-private-metadata-sentinel');",
    ].join('\n')]);
    runtime = await start();
    stage = 'containerInspection';
    const inspected = JSON.parse(docker(['inspect', name]))[0];
    evidence.artifacts.imageIds[state] = inspected.Image;
    checks.requirementsMatch = outside("process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/etc/codex/requirements.toml')).digest('hex'))") === requirementsSha256;
    checks.containerBoundary = inspected.Config.User === '10001:10001' && inspected.HostConfig.NetworkMode === 'none'
      && inspected.HostConfig.ReadonlyRootfs === true && inspected.HostConfig.Privileged === false
      && inspected.HostConfig.CapDrop?.join() === 'ALL' && !inspected.HostConfig.CapAdd?.length
      && ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode'].every(key => inspected.HostConfig[key] !== 'host')
      && JSON.stringify([...inspected.HostConfig.SecurityOpt].sort()) === JSON.stringify([...security.inspect].sort())
      && (!security.appArmorProfile || inspected.AppArmorProfile === security.appArmorProfile)
      && inspected.Mounts.length === 2 && inspected.Mounts.every(mount => mount.Type === 'volume'
        && mount.RW === true && ((mount.Name === home && mount.Destination === '/codex-home')
        || (mount.Name === workspace && mount.Destination === '/home/agent/workspace')));
    const lock = JSON.parse(readFileSync(new URL('../docker/personal-codex/stock-inputs.lock.json', import.meta.url)));
    checks.stockArtifactsMatch = outside("const fs=require('node:fs'),crypto=require('node:crypto');for(const path of ['/opt/codex/bin/codex','/opt/codex/codex-resources/bwrap']) console.log(crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'));") === lock.nativeSha256 + '\n' + lock.bundledBubblewrapSha256
      && outside("process.stdout.write(String(!require('node:fs').existsSync('/usr/bin/bwrap')&&!require('node:fs').existsSync('/usr/local/bin/bwrap')))") === 'true';
    const commands = stockCommands(state);
    const execute = script => runtime.request('command/exec', { command: ['node', '-e', script], cwd: '/home/agent/workspace',
      permissionProfile: 'collective-personal', timeoutMs: 5000, outputBytesCap: 2048 });
    stage = 'networkPositiveControl';
    docker(['exec', '-d', name, 'node', '-e', "const net=require('node:net'),udp=require('node:dgram').createSocket('udp4');net.createServer(socket=>socket.end()).listen(4500,'127.0.0.1');net.createServer(socket=>socket.end()).listen('/home/agent/workspace/fixture-network.sock');udp.on('message',(bytes,remote)=>udp.send('fixture-udp-control',remote.port,remote.address));udp.bind(4501,'127.0.0.1');"]);
    const connect = networkCommand(false);
    const control = () => passedProbe({ result: { exitCode: 0, stdout: outside(connect), stderr: '' } }, 'networkControlReachable');
    for (let i=0; i<30 && outside("process.stdout.write(String(require('node:fs').existsSync('/home/agent/workspace/fixture-network.sock')))")!=='true'; i++) await new Promise(resolve=>setTimeout(resolve,50));
    checks.networkControlReachable = control();
    stage = 'nativeWorkspaceExecution';
    const workspaceReply = await execute(commands.nativeWorkspaceExecution);
    checks.nativeWorkspaceExecution = passedProbe(workspaceReply, 'nativeWorkspaceExecution');
    if (!checks.nativeWorkspaceExecution) {
      const detail = workspaceReply.error?.message ?? workspaceReply.result?.stderr ?? '';
      evidence.failures ??= {};
      evidence.failures[state] = { stage: 'nativeWorkspaceExecution', exitCode: workspaceReply.result?.exitCode ?? null,
        reason: /pivot_root|pivotroot/i.test(detail) ? 'pivot-root-denied' : /namespace/i.test(detail) ? 'unprivileged-namespace-unavailable' : /Read-only file system|Is a directory/.test(detail) ? 'mount-planner-conflict' : 'native-command-unavailable',
        diagnostic: detail.slice(0, 2000) }; // Only this synthetic fixture can emit bounded diagnostics.
    }
    if (!checks.nativeWorkspaceExecution) {
      // Volume persistence is independently testable; no sandbox denial is credited.
      stage = 'backingDataIntegrity';
      checks.backingDataUnchanged = outside(verifyBacking) === 'backing-fixtures-retained';
      await stop();
      runtime = await start('replacement');
      stage = 'replacementStorage';
      checks.storageSurvivesReplacement = outside(verifyBacking) === 'backing-fixtures-retained'
        && outside("process.stdout.write(require('node:fs').readFileSync('/home/agent/workspace/retained.txt','utf8'))") === 'retained-workspace-sentinel';
      return;
    }
    stage = 'nativeProtectionMatrix';
    outside("const cp=require('node:child_process');const child=cp.spawn('node',['-e',\"const fs=require('node:fs');process.chdir('/codex-home');const fd=fs.openSync('/codex-home/unknown-sibling.txt','r');fs.writeFileSync('/home/agent/workspace/fixture-parent.json',JSON.stringify({pid:process.pid,fd,pidNamespace:fs.readlinkSync('/proc/self/ns/pid')}));setInterval(()=>{},1000)\"],{detached:true,stdio:'ignore',env:{PATH:process.env.PATH,CUI_PRIVATE_PARENT:'fixture-parent-process-sentinel'}});child.unref();");
    for (let i=0; i<30 && outside("process.stdout.write(String(require('node:fs').existsSync('/home/agent/workspace/fixture-parent.json')))")!=='true'; i++) await new Promise(resolve=>setTimeout(resolve,50));
    for (const [probe, script] of Object.entries(commands)) {
      if (probe !== 'nativeWorkspaceExecution' && probe !== 'nativeNetworkDenied') checks[probe] = passedProbe(await execute(script), probe);
    }
    checks.nativeNetworkDenied = checks.networkControlReachable && passedProbe(await execute(commands.nativeNetworkDenied), 'nativeNetworkDenied');
    checks.networkControlReachable &&= control();
    checks.nativeNetworkDenied &&= checks.networkControlReachable;
    checks.backingDataUnchanged = outside(verifyBacking) === 'backing-fixtures-retained';
    await stop();
    runtime = await start('replacement');
    stage = 'replacementExecutionAndIntegrity';
    checks.storageSurvivesReplacement = outside(verifyBacking) === 'backing-fixtures-retained'
      && outside("process.stdout.write(require('node:fs').readFileSync('/home/agent/workspace/retained.txt','utf8'))") === 'retained-workspace-sentinel';
    checks.nativeFileSurvivesReplacement = outside("process.stdout.write(require('node:fs').readFileSync('/home/agent/workspace/native-" + state + ".txt','utf8'))") === 'native-mask-fixture';
    checks.replacementExecution = passedProbe(await execute(commands.nativeWorkspaceExecution), 'nativeWorkspaceExecution');
    checks.backingDataUnchanged &&= outside(verifyBacking) === 'backing-fixtures-retained';
    outside("const fs=require('node:fs');const root='/home/agent/workspace/.codex';if(fs.existsSync(root))fs.renameSync(root,root+'-saved');fs.symlinkSync('/codex-home',root);");
    const rejected = await execute("require('node:fs').writeFileSync('/home/agent/workspace/symlink-command-ran','unexpected')");
    const diagnostic = (rejected.error?.message ?? '') + (rejected.result?.stderr ?? '');
    checks.metadataSymlinkFailsClosed = checks.replacementExecution
      && /cannot enforce sandbox (deny-read|read-only) path/.test(diagnostic) && /crosses writable symlink/.test(diagnostic)
      && outside("process.stdout.write(String(require('node:fs').existsSync('/home/agent/workspace/symlink-command-ran')))") === 'false';
    checks.fixtureCompleted = true;
  } catch (error) {
    checks.fixtureCompleted = false;
    const failure = fixtureFailure(error, stage, runtime?.snapshot());
    evidence.failures ??= {};
    if (evidence.failures[state]) { evidence.secondaryFailures ??= {}; evidence.secondaryFailures[state] = failure; }
    else evidence.failures[state] = failure;
  } finally {
    checks.cleanupComplete = await stop();
    const setupRemoved = removeContainer(setupName);
    checks.cleanupComplete = setupRemoved && checks.cleanupComplete;
    for (const volume of [home, workspace]) {
      try { docker(['volume', 'rm', volume]); } catch { checks.cleanupComplete = false; }
    }
  }

  async function start(phase = 'initial') {
    const child = spawn(dockerPath, ['run', '-i', '--name', name, ...base, image, 'node', '/opt/collective-codex/server.mjs', '--stdio'], { stdio: 'pipe',
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', DOCKER_CONFIG: '/nonexistent' } });
    const rpc = fixtureRpc(child);
    const { request, notify } = rpc;
    runtime = { child, ...rpc }; // Register cleanup and diagnostics before initialize.
    stage = `${phase}.initialize`;
    const initialized = await request('initialize', { clientInfo: { name: 'collective_mask_probe', version: 'fixture' }, capabilities: { experimentalApi: true } });
    const version = initialized.result?.userAgent?.includes('/0.163.0-alpha.2 ') === true;
    checks.protocolVersion = checks.protocolVersion === undefined ? version : checks.protocolVersion && version;
    if (!version) throw new Error(initialized.error?.message ?? 'Fixture protocol version mismatch.');
    if (!notify('initialized')) throw new Error('Fixture process unavailable after initialize.');
    stage = `${phase}.managedRequirements`;
    const policy = await request('configRequirements/read', {});
    const managed = policy.result?.requirements?.defaultPermissions === 'collective-personal'
      && policy.result.requirements.allowedLoginMethods?.join() === 'chatgpt';
    checks.managedPolicy = checks.managedPolicy === undefined ? managed : checks.managedPolicy && managed;
    if (!managed) throw new Error(policy.error?.message ?? 'Fixture managed policy mismatch.');
    return runtime;
  }
  async function stop() {
    runtime?.child.stdin.end();
    const removed = removeContainer(name);
    runtime?.child.kill(); runtime = undefined;
    return removed;
  }
  function removeContainer(target) {
    try {
      const exists = docker(['container', 'ls', '-a', '--filter', 'name=^/' + target + '$', '--format', '{{.ID}}']).trim();
      if (exists) docker(['rm', '-f', target]);
      return true;
    } catch { return false; }
  }
}
