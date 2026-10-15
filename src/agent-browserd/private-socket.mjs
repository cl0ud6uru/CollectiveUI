import { chmod, link, lstat, mkdtemp, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/** Publish only a mode-0600 socket. Hard-linking is atomic and never replaces a live pathname.
 * @param {import('node:net').Server} server
 * @param {string} socketPath
 */
export async function listenPrivateSocket(server, socketPath) {
  if (!isAbsolute(socketPath)) throw new Error('An absolute private socket is required');
  const directory = await mkdtemp(join(dirname(socketPath), '.uds-'));
  const staged = join(directory, 's');
  let identity;
  const cleanup = async () => {
    if (identity) {
      const current = await lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) await unlink(socketPath);
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('listening', ready); reject(error); };
      const ready = () => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready);
      server.listen(staged);
    });
    await chmod(staged, 0o600);
    identity = await lstat(staged);
    if (!identity.isSocket() || (identity.mode & 0o777) !== 0o600) throw new Error('Private socket permissions could not be confirmed');
    await link(staged, socketPath);
    await rm(directory, { recursive: true, force: true });
    if (!server.listening) throw new Error('Private socket closed before publication');
    server.once('close', () => { void cleanup().catch(() => {}); });
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await cleanup();
    throw error;
  }
}
