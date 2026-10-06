// Fixed application fixture code. Only the offline image smoke invokes this file.
// Native skill scripts are data; this fixture never loads or executes them.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, chmod, chown, readdir, stat, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const source = 'f97608f178d1ffeca59860195ab7da295f7c8e5f';
let input = ''; for await (const part of process.stdin) { input += part; assert(Buffer.byteLength(input) <= 2 * 1024 * 1024); }
const request = JSON.parse(input);
assert.equal((await readFile('/opt/hermes/.hermes_build_sha', 'utf8')).trim(), source);
assert.equal(Number(process.versions.node.split('.')[0]), 26);
assert.match(request.profile ?? 'cui-team-' + '0'.repeat(32), /^cui-team-[a-f0-9]{32}$/);
const root = '/opt/data', home = root + '/profiles/' + request.profile;
const put = async (file, value) => { await writeFile(file, value, { mode: 0o600 }); };
const sha = value => createHash('sha256').update(value).digest('hex');
let result;
if (request.operation === 'initialize') {
  assert.equal(process.getuid(), 0); assert.equal((await readdir(root)).length, 0);
  await chmod(root, 0o700); await chown(root, 10000, 10000); result = { initialized: true };
} else {
  assert.equal(process.getuid(), 10000);
  if (request.operation === 'seed') {
    assert.match(request.owner, /^(alice|bob)$/);
    // Root personal state is synthetic, retained, and must never enter a Team capture.
    await put(root + '/config.yaml', '{}\n'); await put(root + '/SOUL.md', 'Personal instructions.\n');
    await put(root + '/.env', 'PRIVATE_FIXTURE_SENTINEL=' + request.owner + '\n');
    await mkdir(root + '/memories', { recursive: true, mode: 0o700 });
    await put(root + '/memories/MEMORY.md', request.owner + ' personal memory');
    const created = JSON.parse((await exec('/opt/hermes/.venv/bin/python', ['-B', '/opt/collective-bridge.py', 'create-team', request.profile], {
      cwd: '/opt/hermes', env: { ...process.env, HERMES_HOME: root, HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 15000,
    })).stdout);
    await mkdir(home + '/skills/support/scripts', { recursive: true, mode: 0o700 });
    await mkdir(home + '/skills/support/assets', { mode: 0o700 });
    await put(home + '/skills/support/SKILL.md', 'Use scripts/procedure.sh and assets/example.bin as a useful procedure.\n');
    await put(home + '/skills/support/scripts/procedure.sh', '#!/bin/sh\nprintf executed > /opt/data/SKILL_CODE_EXECUTED\n');
    await put(home + '/skills/support/assets/example.bin', Buffer.from([0, 255, 3, 5]));
    await mkdir(home + '/skills/learned', { mode: 0o700 });
    await put(home + '/skills/learned/SKILL.md', request.owner + ' independently learned procedure.\n');
    await put(home + '/documents/guide.md', 'Shared selected guide.\n');
    await put(home + '/documents/.env', 'PRIVATE_FIXTURE_SENTINEL=excluded\n');
    await put(home + '/memories/MEMORY.md', request.owner + ' private Team memory');
    await put(home + '/sessions/private.json', JSON.stringify({ owner: request.owner, history: 'Never publish conversations.' }));
    const replayed = JSON.parse((await exec('/opt/hermes/.venv/bin/python', ['-B', '/opt/collective-bridge.py', 'create-team', request.profile], {
      cwd: '/opt/hermes', env: { ...process.env, HERMES_HOME: root, HERMES_DISABLE_LAZY_INSTALLS: '1', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 15000,
    })).stdout);
    assert.deepEqual(replayed, created); result = created;
  } else if (request.operation === 'inspect') {
    const metadata = await stat(home, { bigint: true });
    const retained = ['/.env', '/memories/MEMORY.md', '/profiles/' + request.profile + '/memories/MEMORY.md', '/profiles/' + request.profile + '/sessions/private.json'];
    result = { uid: process.getuid(), node: process.versions.node, identity: metadata.dev + ':' + metadata.ino,
      privateHashes: await Promise.all(retained.map(async file => sha(await readFile(root + file)))),
      skillExecuted: await stat(root + '/SKILL_CODE_EXECUTED').then(() => true, () => false),
      quarantine: { config: await readFile(home + '/config.yaml', 'utf8'), env: await readFile(home + '/.env', 'utf8'), auth: await readFile(home + '/auth.json', 'utf8') },
      journalMounted: await stat('/run/collective-team-updates').then(() => true, () => false) };
  } else if (request.operation === 'member-edit') {
    await put(home + '/skills/support/SKILL.md', 'Later private member improvement.\n');
    await put(home + '/skills/support/member-note.txt', 'Private member addition.\n'); result = { edited: true };
  } else if (request.operation === 'unsafe-symlink') {
    await mkdir(home + '/skills/escape', { mode: 0o700 });
    await symlink(root + '/.env', home + '/skills/escape/SKILL.md'); result = { created: true };
  } else if (request.operation === 'remove-unsafe') {
    await rm(home + '/skills/escape', { recursive: true }); result = { removed: true };
  } else if (request.operation === 'journal-inspect') {
    const metadata = await stat('/run/collective-team-updates');
    result = { uid: metadata.uid, gid: metadata.gid, mode: metadata.mode & 0o777 };
  } else if (request.operation === 'checkpoint') {
    // This application-owned bundle calls the real engine with its supported test
    // checkpoint. The subsequent production helper must recover the parked group.
    const { checkpointApply } = await import('/opt/collective-checkpoint.mjs');
    result = await checkpointApply(home, request.profile, request.operationId, request.plan);
  } else throw new Error('Unknown fixed fixture operation');
}
process.stdout.write(JSON.stringify(result));
