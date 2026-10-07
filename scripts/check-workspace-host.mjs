#!/usr/bin/env node
/** Read-only operator preflight for the stock Linux Compose workspace add-on. No installs, secrets or daemon changes. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

/** @param {{platform?: string, env?: Record<string, string | undefined>, read?: (file: string) => string, stat?: (file: string) => {isSocket: () => boolean, gid: number}, run?: (args: string[], options?: {env?: Record<string, string | undefined>}) => string, envFile?: string}} options */
export function checkWorkspaceHost({ platform = process.platform, env = process.env,
  read = file => readFileSync(file, "utf8"),
  stat = file => statSync(file),
  run = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }),
  envFile = ".env",
} = {}) {
  const checks = [];
  const add = (label, ok, detail) => checks.push({ label, ok, detail });
  add("Linux operator host", platform === "linux", "Run this preflight from the CollectiveUI checkout on the Linux Docker host.");
  if (platform !== "linux") return { ready: false, checks };
  let config = {};
  try { config = parseEnv(read(envFile)); }
  catch { add("Operator env file", false, "Create a restricted .env using .env.example, or pass --env-file PATH. This check never creates it."); }
  // Match Compose's shell-over-env-file precedence without printing either source.
  const merged = { ...config, ...env };
  add("Shared secret", Buffer.byteLength(merged.SANDBOXD_SECRET ?? "", "utf8") >= 32, "Set SANDBOXD_SECRET to the same random value for sandboxd, web and worker (at least 32 bytes). Keep it private.");
  let socketGroupMatches = false;
  try {
    // Docker gives an explicitly named context precedence over DOCKER_HOST.
    const host = merged.DOCKER_CONTEXT
      ? JSON.parse(run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}", merged.DOCKER_CONTEXT], { env: merged }))
      : merged.DOCKER_HOST || JSON.parse(run(["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], { env: merged }));
    if (host === "unix:///var/run/docker.sock") {
      const socket = stat("/var/run/docker.sock");
      socketGroupMatches = socket.isSocket() && /^\d+$/.test(merged.DOCKER_GID ?? "") && Number(merged.DOCKER_GID) === socket.gid;
    }
  } catch { /* Fixed failure below: never reflect command output or paths from config. */ }
  add("Docker socket group", socketGroupMatches, "The stock add-on requires the local /var/run/docker.sock context and its actual group ID in DOCKER_GID. Check with stat -c '%g' /var/run/docker.sock. Remote/rootless/custom sockets need a reviewed custom Compose setup. Only sandboxd receives the socket.");
  const runtime = merged.SANDBOXD_RUNTIME || "runsc";
  add("gVisor required", runtime === "runsc", "The supported setup keeps SANDBOXD_RUNTIME=runsc. Standard isolation is a separate, explicit admin decision.");
  let info;
  try {
    info = JSON.parse(run(["info", "--format", '{{json .}}'], { env: merged }));
    if (!info || typeof info !== "object") throw new Error("Invalid Docker response");
  }
  catch { add("Docker connection", false, "Docker is unavailable or access is denied. Check the operator's Docker access and current context locally."); }
  if (info) {
    add("Linux Docker engine", info.OSType === "linux", "The workspace image requires a Linux Docker engine.");
    add("runsc registered", !!info.Runtimes?.runsc, "Install and verify gVisor using docs/operations.md. Registration alone does not prove the runtime works; sandboxd performs its own probe.");
    try { run(["image", "inspect", merged.SANDBOXD_IMAGE || "ai-portal-sandbox:p5", "--format", "{{.Id}}"], { env: merged }); add("Workspace image", true, "The configured image is present."); }
    catch { add("Workspace image", false, "Run npm run sandbox:image on this Docker host. For a custom SANDBOXD_IMAGE, build with the matching SANDBOX_IMAGE tag."); }
  }
  try {
    run(["compose", "--env-file", envFile, "-f", "docker-compose.yml", "-f", "docker-compose.sandbox.yml", "config", "--quiet"], { env: merged });
    add("Compose configuration", true, "The stock Compose files validate. Review the merged mounts/networks privately before starting services.");
  } catch { add("Compose configuration", false, "Check Docker Compose, .env and the stock Compose files locally. Output is withheld because it can include secrets."); }
  return { ready: checks.every(c => c.ok), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: npm run workspace:check -- [--env-file PATH]\nRead-only checks for the stock Linux Compose add-on. No installation or access changes.\nFor custom Compose files/project options, follow docs/operations.md instead.");
  } else if (args.length && (args.length !== 2 || args[0] !== "--env-file" || !args[1] || args[1].startsWith("-"))) {
    console.error("Usage: npm run workspace:check -- [--env-file PATH]"); process.exitCode = 2;
  } else {
    const result = checkWorkspaceHost({ envFile: args[1] || ".env" });
    for (const c of result.checks) console.log(`${c.ok ? "PASS" : "ACTION NEEDED"} ${c.label}: ${c.detail}`);
    console.log(result.ready ? "Host preflight passed. Review and start the Compose add-on, then run the authenticated check in Admin → Workspaces. Access remains unchanged."
      : "Host preflight incomplete. Resolve the actions above and run this command again. Access remains unchanged.");
    process.exitCode = result.ready ? 0 : 1;
  }
}
