import { constants } from 'node:fs';
import { open, realpath, rename, unlink, mkdir, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { companionFailure } from './official-plan-companion-protocol';

/** Existing, operator-approved private directory only. No home creation, chmod, pairing or stale-lock removal. */
export class CompanionPrivateStore {
  private descriptor?: number;
  constructor(readonly directory: string) {}
  private async directoryHandle() {
    if (this.descriptor !== undefined) return open(`/proc/self/fd/${this.descriptor}`, constants.O_RDONLY | constants.O_DIRECTORY);
    const path = resolve(this.directory);
    if (process.platform !== 'linux' || await realpath(path) !== path) throw companionFailure();
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) { await handle.close(); throw companionFailure(); }
    return handle;
  }
  async under<T>(names: string[], create: boolean, operation: (store: CompanionPrivateStore) => Promise<T>) {
    const handles: FileHandle[] = [await this.directoryHandle()];
    try {
      for (const name of names) {
        const path = this.path(handles.at(-1)!, name);
        if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(child); const stat = await child.stat();
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw companionFailure();
      }
      const child = new CompanionPrivateStore(this.directory); child.descriptor = handles.at(-1)!.fd;
      return await operation(child);
    } catch { throw companionFailure(); }
    finally { await Promise.all(handles.map(handle => handle.close())); }
  }
  private path(handle: FileHandle, name: string) {
    if (!/^[a-z0-9][a-z0-9.-]{0,100}$/.test(name)) throw companionFailure();
    return `/proc/self/fd/${handle.fd}/${name}`;
  }
  async read(name: string): Promise<unknown | null> {
    const directory = await this.directoryHandle(); let file: FileHandle | undefined;
    try {
      try { file = await open(this.path(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      const before = await file.stat();
      if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o077) || before.nlink !== 1 || before.size < 1 || before.size > 128000) throw companionFailure();
      const buffer = Buffer.alloc(128001), { bytesRead } = await file.read(buffer, 0, buffer.length, 0), after = await file.stat();
      if (bytesRead !== before.size || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) throw companionFailure();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    } catch { throw companionFailure(); }
    finally { await file?.close(); await directory.close(); }
  }
  async write(name: string, value: unknown) {
    const directory = await this.directoryHandle(), temporary = `${name}.${randomUUID()}`, path = this.path(directory, temporary); let file: FileHandle | undefined;
    try {
      const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > 128000) throw companionFailure();
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(bytes); await file.sync(); await file.close(); file = undefined;
      await rename(path, this.path(directory, name)); await directory.sync();
    } catch { throw companionFailure(); }
    finally { await file?.close(); await unlink(path).catch(() => {}); await directory.close(); }
  }
  async remove(name: string) {
    const directory = await this.directoryHandle();
    try { await unlink(this.path(directory, name)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); await directory.sync(); }
    catch { throw companionFailure(); } finally { await directory.close(); }
  }
  async locked<T>(operation: () => Promise<T>) {
    const directory = await this.directoryHandle(); let lock: FileHandle;
    try { lock = await open(this.path(directory, 'operation.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await lock.sync(); await directory.sync(); }
    catch { await directory.close(); throw companionFailure(); }
    try { return await operation(); }
    finally { await lock.close(); await unlink(this.path(directory, 'operation.lock')); await directory.sync(); await directory.close(); }
  }
  async isLocked() {
    const directory = await this.directoryHandle();
    try { const lock = await open(this.path(directory, 'operation.lock'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); await lock.close(); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw companionFailure(); }
    finally { await directory.close(); }
  }
}
