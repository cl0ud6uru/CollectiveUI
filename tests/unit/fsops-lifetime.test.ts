import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const fixture = `import pathlib, sys, tempfile
source, mode = sys.argv[1:]
ns = {"__name__": "fixture"}
exec(compile(pathlib.Path(source).read_text(), source, "exec"), ns)
with tempfile.TemporaryDirectory(prefix="fsops-lifetime-") as root:
    root = str(pathlib.Path(root).resolve())
    ns["WORKSPACE"] = ns["HOME"] = root
    if mode == "grep":
        pathlib.Path(root, "slow.txt").write_text("a" * 30000 + "!")
        sys.argv = ["fsops", "grep", "--max-matches", "1", "--", "(a+)+$", "slow.txt"]
    else:
        sys.argv = ["fsops", "write", "--max-bytes", "100", "--", "waiting.txt"]
    ns["main"]()
`;

it.skipIf(process.platform === "win32").concurrent.each(["grep", "stdin"])("actual fsops terminates its own %s process before the daemon gives up", async mode => {
  const child = spawn("python3", ["-I", "-c", fixture, resolve("docker/sandbox/fsops"), mode], { stdio: ["pipe", "ignore", "pipe"] });
  // Keep stdin attached and open. The write case must end through the helper's wall alarm, not EOF or detach.
  let timedOut = false, stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096); });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 50_000);
  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    expect(timedOut, stderr).toBe(false);
    expect(outcome.code, stderr).toBeNull();
    expect(mode === "stdin" ? ["SIGALRM"] : ["SIGALRM", "SIGXCPU", "SIGKILL"]).toContain(outcome.signal);
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}, 60_000);
