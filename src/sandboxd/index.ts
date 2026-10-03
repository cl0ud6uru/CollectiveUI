/**
 * sandboxd: the only process with docker.sock. Runs each person's workspace container and the commands and file
 * operations the portal asks for, with fixed specs. No database, no model keys, no npm dependencies; it runs on plain
 * Node (type stripping):
 *
 *   node src/sandboxd/index.ts           serve (SANDBOXD_* environment, see config.ts)
 *   node src/sandboxd/index.ts --check   start-up checks against Docker, print health, exit 0/1
 *   node src/sandboxd/index.ts --help
 */
import { loadConfig } from "./config.ts";
import { Docker } from "./docker.ts";
import { Manager } from "./manager.ts";
import { createServer } from "./server.ts";

const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("usage: sandboxd [--check]   (configure with SANDBOXD_SECRET, SANDBOXD_LISTEN, SANDBOXD_IMAGE, SANDBOXD_RUNTIME, …)");
    return;
  }
  const config = loadConfig();
  const manager = new Manager(new Docker(config.socketPath), config, log);
  try {
    await manager.init();
  } catch (err) {
    log("start-up checks failed", { error: (err as Error).message });
    process.exit(1);
  }
  if (args.includes("--check")) {
    console.log(JSON.stringify(await manager.health(), null, 2));
    return;
  }
  for (const w of manager.warnings) log("warning", { warning: w });

  const server = createServer(manager, config, log);
  server.listen(config.port, config.host, () => log("sandboxd listening", { host: config.host, port: config.port, instance: config.instance }));

  const reaper = setInterval(() => {
    manager
      .reap()
      .then((stopped) => stopped.length && log("stopped idle sandboxes", { count: stopped.length }))
      .catch((err) => log("reaper failed", { error: String(err) }));
  }, Math.min(60_000, Math.max(1000, config.idleMinutes * 60_000)));

  const shutdown = () => {
    clearInterval(reaper);
    server.close(() => process.exit(0));
    // Streams still open: commands see their lifeline close and stop.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log("sandboxd crashed", { error: String((err as Error)?.stack ?? err) });
  process.exit(1);
});
