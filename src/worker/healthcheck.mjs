import { lstat } from "node:fs/promises";

const directory = "/tmp/collectiveui-worker";
const marker = `${directory}/ready`;
const maxAgeMs = 45_000;

try {
  const [dir, file] = await Promise.all([lstat(directory), lstat(marker)]);
  const ageMs = Date.now() - file.mtimeMs;
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0 ||
      !file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0 || ageMs < 0 || ageMs > maxAgeMs) {
    process.exitCode = 1;
  }
} catch {
  process.exitCode = 1;
}
