import { request } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { HttpError } from "@/lib/authz";
import type { LocalController } from "@/local-hermes/controller";
import type { LocalBinding } from "@/local-hermes/controller";

export type LocalStatus = ReturnType<LocalController["status"]>;
/** This URL is never resolved or sent to the network. It is only an internal adapter namespace. */
export const LOCAL_ORIGIN = "http://local-hermes.invalid";
export function localSocketPath() {
  const socket = process.env.LOCAL_HERMES_SOCKET;
  if (!socket || !path.isAbsolute(socket) || /[\x00-\x1f]/.test(socket))
    throw new HttpError(503, "Local Hermes is not configured on this runtime. Set LOCAL_HERMES_SOCKET for both web and worker; see the Local Hermes setup guide.");
  return socket;
}
export function socketFetch(socketPath: string): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin !== LOCAL_ORIGIN || url.search || url.hash || url.username || url.password) throw new Error("Invalid controller destination");
    if (init.body != null && typeof init.body !== "string") throw new Error("Local controller accepts JSON text only");
    const headers = Object.fromEntries(new Headers(init.headers));
    // IPC authenticates through filesystem access, not a profile credential or inherited app token.
    delete headers.authorization;
    return new Promise<Response>((resolve, reject) => {
      const req = request({ socketPath, path: url.pathname, method: init.method ?? "GET", headers, signal: init.signal ?? undefined }, res => {
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v) outHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status: res.statusCode ?? 502, headers: outHeaders }));
      });
      req.once("error", reject); req.end(init.body);
    });
  }) as typeof fetch;
}
export async function localControl<T = LocalStatus>(action: "status" | "start" | "reconnect" | "stop" | "pair", data?: unknown): Promise<T> {
  try {
    const res = await socketFetch(localSocketPath())(`${LOCAL_ORIGIN}/control/${action}`, {
      method: action === "status" ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      body: action === "status" ? undefined : JSON.stringify(data ?? {}), signal: AbortSignal.timeout(45_000),
    });
    const result = await res.json();
    if (!res.ok) throw new HttpError(res.status, result.error ?? "Local Hermes operation failed");
    return result as T;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, "The local controller is unreachable. Check that it is running and that web and worker can access its socket.");
  }
}
export const pairLocal = (data: unknown) => localControl<LocalBinding>("pair", data);
