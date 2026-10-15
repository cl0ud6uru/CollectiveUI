/** Disposable CI orchestration only. The app and browser spec remain at the accepted SHA. */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AcceptanceRefusal, acceptanceDiagnostic, browserAcceptanceEnvironment, EXPECTED_BROWSER_CASES } from './lib/docker-hermes-browser-guard.mjs';

const children = [], logs = [];
let phase = 'environment guard', evidencePath;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const git = (root, args) => {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new AcceptanceRefusal('source_git_failed');
  return result.stdout.trim();
};
async function start(root, executable, args, env, label) {
  const child = spawn(executable, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  // Raw logs remain on this disposable runner and are never printed or uploaded.
  const chunks = []; logs.push(chunks);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { if (chunks.length < 1000) chunks.push(data); });
  child.on('error', () => undefined);
  child.fixtureLabel = label;
  return child;
}
async function finished(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise(resolve => { child.once('exit', code => resolve(code ?? 1)); child.once('error', () => resolve(1)); });
}
async function until(check, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    if (children.some(child => child.exitCode !== null && child.fixtureService)) throw new AcceptanceRefusal('fixture_service_exited');
    await sleep(500);
  }
  throw new AcceptanceRefusal('fixture_readiness_timeout');
}
async function main() {
  // This must run before loading pg, the application, its fixtures, or any connection-capable dependency.
  const accepted = browserAcceptanceEnvironment(process.env);
  phase = 'source guard';
  const workspace = await realpath(process.env.GITHUB_WORKSPACE);
  const appRoot = await realpath(path.join(workspace, 'acceptance-target'));
  if (path.dirname(appRoot) !== workspace) throw new AcceptanceRefusal('source_location');
  if (git(appRoot, ['rev-parse', 'HEAD']) !== accepted.appSha) throw new AcceptanceRefusal('source_pin_mismatch');
  if (git(appRoot, ['status', '--porcelain', '--untracked-files=no'])) throw new AcceptanceRefusal('source_dirty');
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local', '.env.development', '.env.development.local']) {
    if (await access(path.join(appRoot, name)).then(() => true, () => false)) throw new AcceptanceRefusal('ambient_app_env_file');
  }
  if (process.argv.includes('--guard-only')) { console.log(`Disposable boundary verified for ${accepted.appSha}.`); return; }
  const temp = await mkdtemp(path.join(await realpath(process.env.RUNNER_TEMP), 'hermes-browser-'));
  const output = path.join(workspace, 'acceptance-evidence'); await mkdir(output, { recursive: true });
  evidencePath = path.join(output, 'summary.json');
  const evidence = { applicationSha: accepted.appSha, browserSpecSha: accepted.appSha, harnessSha: accepted.harnessSha, suite: 'tests/e2e/docker-hermes.spec.ts', expectedCases: EXPECTED_BROWSER_CASES, phase: 'starting', passed: 0, failed: 0, skipped: 0, cases: [] };
  const save = async () => writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  await save();
  const env = {
    PATH: process.env.PATH, HOME: temp, TMPDIR: temp, CI: 'true', NEXT_TELEMETRY_DISABLED: '1',
    DATABASE_URL: accepted.databaseUrl, AUTH_LOCAL_ENABLED: 'true', AUTH_ENTRA_ENABLED: 'false', LDAP_ENABLED: 'false',
    AUTH_URL: 'http://localhost:3327', AUTH_TRUST_HOST: 'true', AUTH_SECRET: randomBytes(32).toString('base64'), ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    NODE_ENV: 'development', STORAGE_DIR: path.join(temp, 'uploads'),
    DOCKER_HERMES_BROWSER: '1', DOCKER_HERMES_BROWSER_ONLINE: '1', DOCKER_HERMES_BROWSER_ENV: path.join(temp, 'broker.env'),
    BASE_URL: 'http://localhost:3327', PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(temp, 'playwright.json'),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  };
  phase = 'fresh disposable database';
  const require = createRequire(path.join(appRoot, 'package.json'));
  const { Client } = require('pg');
  const db = new Client({ connectionString: accepted.databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await db.connect();
    const { rows } = await db.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p')");
    if (rows[0].n !== 0) throw new AcceptanceRefusal('database_not_fresh');
  } finally { await db.end(); }
  const node = path.join(appRoot, 'node_modules/.bin/tsx');
  phase = 'migrations'; if (await finished(await start(appRoot, node, ['src/db/migrate.ts'], env, phase)) !== 0) throw new AcceptanceRefusal('migration_failed');
  phase = 'synthetic broker';
  const broker = await start(appRoot, node, ['tests/fixtures/docker-hermes-browser.ts'], env, phase); broker.fixtureService = true;
  await until(() => access(env.DOCKER_HERMES_BROWSER_ENV).then(() => true, () => false));
  const brokerEnv = await readFile(env.DOCKER_HERMES_BROWSER_ENV, 'utf8');
  const match = /^DOCKER_HERMES_SOCKET=(\/[^\r\n]+)\n$/.exec(brokerEnv);
  if (!match || !match[1].startsWith(`${temp}/`)) throw new AcceptanceRefusal('synthetic_broker_address');
  env.DOCKER_HERMES_SOCKET = match[1];
  phase = 'worker';
  if (await access('/tmp/collectiveui-worker/ready').then(() => true, () => false)) throw new AcceptanceRefusal('unexpected_worker_marker');
  const worker = await start(appRoot, node, ['src/worker/index.ts'], env, phase); worker.fixtureService = true;
  await until(() => access('/tmp/collectiveui-worker/ready').then(() => true, () => false));
  phase = 'real app';
  const app = await start(appRoot, process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3327'], env, phase); app.fixtureService = true;
  await until(() => fetch('http://localhost:3327/login').then(r => r.ok, () => false), 180000);
  phase = 'browser acceptance';
  const browser = await start(appRoot, process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.docker-hermes.config.ts', '--reporter=json'], env, phase);
  const code = await finished(browser);
  const report = JSON.parse(await readFile(env.PLAYWRIGHT_JSON_OUTPUT_FILE, 'utf8'));
  const walk = suites => suites.flatMap(suite => [...(suite.specs ?? []).map(spec => ({ title: spec.title, statuses: spec.tests.flatMap(test => test.results.map(result => result.status)) })), ...walk(suite.suites ?? [])]);
  const cases = walk(report.suites ?? []);
  // Only source-authored titles, canonical status strings and aggregate counts leave the runner.
  const source = await readFile(path.join(appRoot, 'tests/e2e/docker-hermes.spec.ts'), 'utf8');
  evidence.cases = cases.map(item => ({ title: source.includes(`test('${item.title}'`) ? item.title : '(unrecognized case)', statuses: item.statuses.map(s => ['passed', 'failed', 'skipped', 'timedOut', 'interrupted'].includes(s) ? s : 'unknown') }));
  evidence.passed = cases.filter(c => c.statuses.length === 1 && c.statuses[0] === 'passed').length;
  evidence.failed = cases.filter(c => c.statuses.some(s => s !== 'passed' && s !== 'skipped')).length;
  evidence.skipped = cases.filter(c => c.statuses.includes('skipped')).length;
  evidence.phase = phase;
  evidence.sourceUnchanged = git(appRoot, ['rev-parse', 'HEAD']) === accepted.appSha && !git(appRoot, ['status', '--porcelain', '--untracked-files=no']);
  await save();
  if (code !== 0 || evidence.passed !== EXPECTED_BROWSER_CASES || evidence.failed || evidence.skipped || !evidence.sourceUnchanged) throw new AcceptanceRefusal('browser_cases_not_passed');
  console.log(`PASS: ${EXPECTED_BROWSER_CASES} browser cases on accepted app/spec ${accepted.appSha}.`);
}
try { await main(); }
catch (error) {
  const diagnostic = acceptanceDiagnostic(error);
  try { if (evidencePath) {
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8')); evidence.phase = phase; evidence.outcome = 'not_passed'; evidence.diagnostic = diagnostic; await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  }
  } catch { /* A failed evidence write must not expose raw filesystem errors. */ }
  console.error(JSON.stringify({ outcome: 'not_passed', phase, ...diagnostic })); process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Only our own process group. */ }
    await Promise.race([finished(child), sleep(45000)]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
  }
}
