import { chmod, link, lstat, mkdtemp, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

/** Publish only a mode-0600 socket. Hard-linking is atomic and never replaces a live pathname.
 * The returned cleanup is idempotent; await it before explicitly exiting the process.
 * @param {import('node:net').Server} server
 * @param {string} socketPath
 * @param {AbortSignal} [signal]
 */
export async function listenPrivateSocket(server, socketPath, signal) {
  signal?.throwIfAborted();
  if (!isAbsolute(socketPath)) throw new Error('An absolute private socket is required');
  const directory = await mkdtemp(join(dirname(socketPath), '.uds-'));
  const staged = join(directory, 's');
  let identity, cleanupWork;
  const cleanup = () => cleanupWork ??= (async () => {
    if (identity) {
      const current = await lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) await unlink(socketPath);
    }
    await rm(directory, { recursive: true, force: true });
  })();
  const aborted = () => { server.close(() => {}); };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const failed = error => { server.removeListener('error', failed); server.removeListener('listening', ready); signal?.removeEventListener('abort', cancelled); reject(error); };
      const ready = () => { server.removeListener('error', failed); signal?.removeEventListener('abort', cancelled); resolve(); };
      const cancelled = () => failed(signal.reason);
      server.once('error', failed); server.once('listening', ready);
      signal?.addEventListener('abort', cancelled, { once: true });
      try { server.listen(staged); } catch (error) { server.removeListener('error', failed); failed(error); }
    });
    signal?.throwIfAborted();
    await chmod(staged, 0o600);
    signal?.throwIfAborted();
    identity = await lstat(staged);
    signal?.throwIfAborted();
    if (!identity.isSocket() || (identity.mode & 0o777) !== 0o600) throw new Error('Private socket permissions could not be confirmed');
    await link(staged, socketPath);
    signal?.throwIfAborted();
    await rm(directory, { recursive: true, force: true });
    signal?.throwIfAborted();
    if (!server.listening) throw new Error('Private socket closed before publication');
    server.once('close', () => { void cleanup().catch(() => {}); });
    return cleanup;
  } catch (error) {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await cleanup();
    throw error;
  } finally { signal?.removeEventListener('abort', aborted); }
}
