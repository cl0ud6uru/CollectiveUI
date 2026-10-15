import { networkInterfaces } from "node:os";
import { listenPrivateSocket } from "./private-socket.mjs";
import { BrowserRuntime } from "./runtime.ts";
import { createBrowserServer } from "./server.ts";
import { unixEgress } from "./egress.ts";

/** Fail closed. Production broker must run non-root in its own network:none container. */
export function assertBrowserIsolation(env: Record<string, string | undefined> = process.env, interfaces = networkInterfaces(), uid = process.getuid?.()) {
  if (env.AGENT_BROWSERD_ENABLED !== "1" || env.AGENT_BROWSERD_ISOLATION !== "network-none" || uid === undefined || uid === 0 ||
      Object.values(interfaces).some(entries => entries?.some(entry => !entry.internal)))
    throw new Error("Agent browser requires explicit opt-in, a non-root user and network:none isolation");
}

if (process.argv[1]?.endsWith("/index.ts")) {
  assertBrowserIsolation();
  const socket = process.env.AGENT_BROWSER_SOCKET;
  const egressSocket = process.env.AGENT_BROWSER_EGRESS_SOCKET;
  const egressSecret = process.env.AGENT_BROWSER_EGRESS_SECRET;
  if (!socket?.startsWith("/") || !egressSocket?.startsWith("/") || !egressSecret || egressSecret.length < 32)
    throw new Error("Private browser and egress Unix sockets and a dedicated egress secret are required");
  const runtime = new BrowserRuntime({ egress: unixEgress(egressSocket, egressSecret), executablePath: "/usr/bin/chromium" });
  const server = createBrowserServer(runtime, process.env.AGENT_BROWSER_SECRET ?? "");
  const sweep = setInterval(() => { void runtime.sweep(); }, 10_000);
  const startup = new AbortController();
  let stopping = false;
  for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => {
    if (stopping) return; stopping = true; startup.abort(); clearInterval(sweep);
    server.close(() => {});
    void runtime.shutdown().finally(async () => {
      server.closeAllConnections();
      const cleanup = await publication?.catch(() => undefined); await cleanup?.();
    });
  });
  const publication = listenPrivateSocket(server, socket, startup.signal);
  try { await publication; } catch (error) { if (!stopping) throw error; }
}
