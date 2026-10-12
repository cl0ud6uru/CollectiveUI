import { lstat, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const SANDBOX_PROFILE = 'collectiveui-sandbox-v1';
export const SECCOMP_PATH = '/etc/collectiveui/security/collectiveui-seccomp-v1.json';
export const SECCOMP_SHA256 = 'e077360ce81d54eb7acf5d15d20e7c9444a16c68ea50a38ac66cb8e3ccf13370';
export const APPARMOR_PATH = '/etc/apparmor.d/collectiveui-sandbox-v1';
export const APPARMOR_SHA256 = 'f9f89ce0a645d5d90b326908d384ad1c0553b71003944a9628bd5c83e4c90d81';
const denied = () => new Error('Reviewed sandbox policy requires operator reconciliation.');

async function pinnedFile(path, digest) {
  const file = await lstat(path);
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o222)) throw denied();
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const dir = await lstat(parent);
    if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o022)) throw denied();
    if (parent === '/') break;
  }
  const bytes = await readFile(path);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw denied();
  return bytes;
}

/** No arbitrary paths, hashes or security-opt values are operator inputs. */
export async function sandboxPolicy(profile) {
  const baseline = ['no-new-privileges:true'];
  if (profile === undefined) return { create: baseline, inspect: baseline };
  if (profile !== SANDBOX_PROFILE) throw denied();
  try {
    await pinnedFile(APPARMOR_PATH, APPARMOR_SHA256);
    const seccomp = JSON.stringify(JSON.parse((await pinnedFile(SECCOMP_PATH, SECCOMP_SHA256)).toString('utf8')));
    return { create: [...baseline, `apparmor=${SANDBOX_PROFILE}`, `seccomp=${SECCOMP_PATH}`],
      inspect: [...baseline, `apparmor=${SANDBOX_PROFILE}`, `seccomp=${seccomp}`], appArmorProfile: SANDBOX_PROFILE };
  } catch { throw denied(); }
}

export function dockerExecutable(value = '/usr/local/bin/docker') {
  if (!['/usr/local/bin/docker', '/usr/bin/docker'].includes(value)) throw denied();
  return value;
}
