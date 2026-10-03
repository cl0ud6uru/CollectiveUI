import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Starts dev/mock-llm on a free port; returns its base URL (without /v1) and a stop function. */
export async function startMockLlm(): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../../dev/mock-llm/server.mjs")], {
    env: { ...process.env, PORT: String(port), MOCK_DELAY_MS: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock-llm did not start")), 10_000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`mock-llm exited (${code})`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

/**
 * Starts dev/mcp-echo on a free port; `env` may depend on its /mcp URL (e.g. the audience it checks).
 * Returns its /mcp URL, its base URL and a stop function.
 */
export async function startMcpEcho(
  env: Record<string, string> | ((url: string) => Record<string, string>) = {},
): Promise<{ url: string; base: string; stop: () => void }> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn(process.execPath, [path.resolve(import.meta.dirname, "../../../dev/mcp-echo/server.mjs")], {
    env: { ...process.env, PORT: String(port), ...(typeof env === "function" ? env(`${base}/mcp`) : env) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mcp-echo did not start")), 10_000);
    child.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => reject(new Error(`mcp-echo exited (${code})`)));
  });
  return { url: `${base}/mcp`, base, stop: () => child.kill() };
}
