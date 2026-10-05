import { createServer } from "node:http";
import { once } from "node:events";
import { attempt, exchange, consume } from "./oauth.mjs";
import { hostId, load, save } from "./storage.mjs";
export async function auth(file, options = {}) {
  const saved = await load(file);
  const host = await hostId(file);
  if (saved && saved.ext_agent_host_id !== host)
    throw Error("Saved account belongs to another host");
  let a, timer, resolve, reject;
  const done = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  done.catch(() => {});
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain");
    let q;
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (req.method !== "GET" || u.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      q = u.searchParams;
      if (q.get("state") !== a.state) {
        res.writeHead(400);
        res.end("Invalid callback state");
        return;
      }
      if (a.consumed) {
        res.writeHead(409);
        res.end("Attempt already consumed");
        return;
      }
      // Exchange synchronously consumes state before its first asynchronous operation.
      const promise = options.exchange
        ? (consume(a, q), options.exchange(a, q))
        : exchange(a, q, options);
      clearTimeout(timer);
      const credentials = await promise;
      await save(file, credentials);
      res.end("Sign-in complete. Return to the terminal.");
      resolve(credentials);
    } catch {
      res.writeHead(400);
      res.end("Sign-in failed. Return to the terminal.");
      reject(
        Error(
          q?.has("error")
            ? "Authorization denied or failed"
            : "Authorization validation or exchange failed",
        ),
      );
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    server.listen(options.port ?? 0, "127.0.0.1");
    await once(server, "listening");
    a = attempt({
      host,
      saved,
      redirect: `http://127.0.0.1:${server.address().port}/auth/callback`,
      timeoutMs: options.timeoutMs ?? 180000,
    });
    timer = setTimeout(
      () => reject(Error("Authorization attempt expired")),
      options.timeoutMs ?? 180000,
    );
    // Optional retained id_token_hint is deliberately omitted from printed URLs.
    const visible = new URL(a.url);
    visible.searchParams.delete("id_token_hint");
    a.url = visible.href;
    await options.onReady?.(a);
    return await done;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}
