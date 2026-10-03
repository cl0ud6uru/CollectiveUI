import { z } from "zod";
import { access, realpath, stat, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { createHash } from "node:crypto";

export const HERMES_COMMIT = "f97608f178d1ffeca59860195ab7da295f7c8e5f";
export const HERMES_RELEASE = "v2026.9.24";
const absolute = z.string().min(1).max(4096).refine(v => path.isAbsolute(v) && !/[\x00-\x1f]/.test(v), "Use an absolute path without control characters");
export const ControllerConfig = z.object({
  trust: z.literal("single-user-exclusive-profile"),
  python: absolute, source: absolute, profileHome: absolute, workDir: absolute,
  // Must belong to a dedicated runtime account, not the web/worker account.
  accountHome: absolute, stateDir: absolute, socketPath: absolute,
  tirithPath: absolute.optional(),
  label: z.string().trim().min(1).max(100),
}).strict();
export type ControllerConfig = z.infer<typeof ControllerConfig>;
const exec = promisify(execFile);

export function childEnvironment(c: ControllerConfig): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", HOME: c.accountHome, PATH: `${path.dirname(c.python)}:/usr/local/bin:/usr/bin:/bin`,
    LANG: "C.UTF-8", HERMES_HOME: c.profileHome, PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1", HERMES_DISABLE_LAZY_INSTALLS: "1", HERMES_LAZY_INSTALL_TARGET: "",
    // An explicit path prevents the pinned native scanner from auto-downloading its default binary.
    TIRITH_BIN: c.tirithPath ?? path.join(c.profileHome, "bin/tirith") };
}

export async function validateInstallation(raw: unknown) {
  if (process.platform !== "linux") throw new Error("Local Hermes pilot requires a Linux runtime. Use Remote Hermes on other hosts.");
  const c = ControllerConfig.parse(raw);
  for (const key of ["source", "profileHome", "workDir", "accountHome", "stateDir"] as const) {
    c[key] = await realpath(c[key]);
    if (!(await stat(c[key])).isDirectory()) throw new Error(`${key} must be an existing directory`);
  }
  await access(c.python, constants.X_OK);
  if (!(await stat(c.python)).isFile()) throw new Error("Python must be an executable file");
  if (path.dirname(c.socketPath) !== await realpath(path.dirname(c.socketPath)) || Buffer.byteLength(c.socketPath) > 100)
    throw new Error("Use a canonical socket directory and a socket path under 100 bytes");
  for (const dir of [c.stateDir, path.dirname(c.socketPath)]) {
    const s = await stat(dir);
    if (s.mode & 0o007) throw new Error("Controller state and socket directories must not be accessible to other users (use 0700 or a trusted 0770 group)");
  }
  if (c.stateDir === c.profileHome || c.stateDir.startsWith(`${c.profileHome}/`)) throw new Error("Keep controller metadata outside the Hermes profile");
  // No discovery or execution of arbitrary shell strings, and no inherited Git configuration/secrets.
  const opts = { cwd: c.source, env: { NODE_ENV: "production" as const, PATH: "/usr/bin:/bin", HOME: c.accountHome, GIT_CONFIG_NOSYSTEM: "1" }, timeout: 5000, maxBuffer: 65536 };
  const { stdout: head } = await exec("/usr/bin/git", ["rev-parse", "HEAD"], opts);
  const { stdout: dirty } = await exec("/usr/bin/git", ["status", "--porcelain", "--untracked-files=no"], opts);
  if (head.trim() !== HERMES_COMMIT || dirty.trim()) throw new Error(`Use an unmodified Hermes ${HERMES_RELEASE} source installation (${HERMES_COMMIT.slice(0, 12)}). Other versions are not supported by this pilot.`);
  await access(path.join(c.source, "tui_gateway/entry.py"));
  await access(path.join(c.profileHome, "config.yaml"));
  // Read only policy booleans: never return credentials, hydrate external secrets, or edit native files.
  const policyCheck = `import sys,yaml,json,os
from pathlib import Path
from dotenv import dotenv_values
c=yaml.safe_load(Path(sys.argv[1]).read_text()) or {}
s=c.get('security') or {}
reserved=('HERMES_HOME','HERMES_DISABLE_LAZY_INSTALLS','HERMES_LAZY_INSTALL_TARGET','TIRITH_BIN','HERMES_MANAGED_DIR')
unsafe=False
for p in (Path(sys.argv[1]).parent/'.env',Path(sys.argv[1]).parent/'.op.env',Path.cwd()/'.env',Path('/etc/hermes/.env')):
 if p.exists():
  values=dotenv_values(p)
  unsafe=unsafe or any(k in values and values[k] != os.environ.get(k, '') for k in reserved)
print(json.dumps({'scanner':s.get('tirith_enabled',True) is not False,'lazy':s.get('allow_lazy_installs',True) is not False,'unsafe':unsafe}))`;
  const { stdout: security } = await exec(c.python, ["-c", policyCheck, path.join(c.profileHome, "config.yaml")],
    { cwd: c.source, env: childEnvironment(c), timeout: 5000, maxBuffer: 1024 });
  const policy = z.object({ scanner: z.boolean(), lazy: z.boolean(), unsafe: z.boolean() }).parse(JSON.parse(security));
  if (policy.lazy || policy.unsafe) throw new Error("Native profile policy is incompatible: set security.allow_lazy_installs to false using Hermes configuration, and remove conflicting controller-owned environment overrides. No native files were changed.");
  if (policy.scanner) {
    await access(childEnvironment(c).TIRITH_BIN!, constants.X_OK).catch(() => {
      throw new Error("The profile enables Tirith security scanning. Set tirithPath to its existing executable (or install it through native Hermes setup). Automatic downloads are disabled in this pilot.");
    });
  }
  return c;
}

export const installationId = (c: ControllerConfig) => createHash("sha256").update(JSON.stringify([c.source, c.python, c.profileHome, c.workDir, HERMES_COMMIT])).digest("hex");

/** Conservative preflight for a dedicated runtime account. Unknown /proc visibility fails closed. */
export async function assertNoOtherHermes(c: ControllerConfig) {
  for (const pid of (await readdir("/proc")).filter(p => /^\d+$/.test(p) && Number(p) !== process.pid)) {
    try {
      if ((await stat(`/proc/${pid}`)).uid !== process.getuid!()) continue;
      const argv = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (!argv || !/^(?:python(?:\d+(?:\.\d+)?)?|hermes)$/.test(path.basename(argv.split("\0")[0]))) continue;
      const env = await readFile(`/proc/${pid}/environ`, "utf8");
      if (/tui_gateway|hermes_cli|hermes-agent|\/hermes\0/.test(argv) || env.split("\0").includes(`HERMES_HOME=${c.profileHome}`))
        throw new Error("Another Hermes process is running under this runtime account. Stop it before starting Local Hermes; the selected profile must have one owner.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      throw error;
    }
  }
}
