import { Client } from "pg";
import { RUN_CHANNEL, type RunSignal } from "./types";

/**
 * One dedicated pg.Client per process on LISTEN portal_runs (not from the pool), cached on globalThis. Pings every
 * 30 s; on error/end reconnects with a fresh client (backoff 0.5 s → 10 s) and then calls every subscriber with
 * `{ r, k: "reconnect" }` (subscribeAll: `{ r: "*", k: "reconnect" }`) so they re-query: a NOTIFY can be missed while
 * disconnected. The first LISTEN wakes subscribers the same way (they may have subscribed before it was active).
 */
export type RunListener = {
  /** Signals for one run; returns unsubscribe. */
  subscribe(runId: string, fn: (sig: RunSignal | { r: string; k: "reconnect" }) => void): () => void;
  /** Every signal (the worker: cancels and requeues for runs it holds). */
  subscribeAll(fn: (sig: RunSignal | { r: "*"; k: "reconnect" }) => void): () => void;
  /** Resolves on the next signal for runId, after `ms`, or when `signal` aborts. */
  wait(runId: string, ms: number, signal?: AbortSignal): Promise<"signal" | "timeout" | "aborted">;
  /** Resolves once the LISTEN is active (first connection). */
  ready(): Promise<void>;
  close(): Promise<void>;
};

type RunFn = Parameters<RunListener["subscribe"]>[1];
type AllFn = Parameters<RunListener["subscribeAll"]>[0];

const PING_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 10_000;
const SIGNAL_KINDS = new Set(["e", "c", "q", "t"]);

const g = globalThis as unknown as { __portalRunListener?: RunListener };

export function runListener(): RunListener {
  if (g.__portalRunListener) return g.__portalRunListener;
  const l = createRunListener();
  const close = l.close;
  // A closed listener (worker shutdown) isn't handed out again.
  l.close = async () => {
    if (g.__portalRunListener === l) delete g.__portalRunListener;
    await close();
  };
  g.__portalRunListener = l;
  return l;
}

/** A NOTIFY payload as a RunSignal, or null when it isn't one (payloads are ids only; anything else is ignored). */
export function parseRunSignal(payload: string | undefined): RunSignal | null {
  if (!payload) return null;
  try {
    const v = JSON.parse(payload) as { r?: unknown; k?: unknown };
    if (typeof v?.r !== "string" || !v.r || typeof v.k !== "string" || !SIGNAL_KINDS.has(v.k)) return null;
    return { r: v.r, k: v.k as RunSignal["k"] };
  } catch {
    return null;
  }
}

/** A listener on its own connection (tests: two "instances" in one process). */
export function createRunListener(connectionString?: string): RunListener {
  const url = connectionString ?? process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/portal";
  const subs = new Map<string, Set<RunFn>>();
  const all = new Set<AllFn>();
  let client: Client | null = null;
  let connecting = false;
  let closed = false;
  let connectedOnce = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let readyWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  const call = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.error("[runs] listener subscriber failed", err);
    }
  };

  const deliver = (sig: RunSignal) => {
    for (const fn of [...(subs.get(sig.r) ?? [])]) call(() => fn(sig));
    for (const fn of [...all]) call(() => fn(sig));
  };

  const wakeAll = () => {
    for (const [r, set] of subs) for (const fn of [...set]) call(() => fn({ r, k: "reconnect" }));
    for (const fn of [...all]) call(() => fn({ r: "*", k: "reconnect" }));
  };

  const drop = (c: Client) => {
    // A dead client may still emit errors; without a listener they'd crash the process.
    c.removeAllListeners("notification");
    c.removeAllListeners("end");
    c.on("error", () => {});
    c.end().catch(() => {});
  };

  const lost = (c: Client, why: unknown) => {
    if (client !== c) return;
    client = null;
    if (ping) clearInterval(ping);
    ping = null;
    drop(c);
    if (closed) return;
    console.warn("[runs] run listener disconnected, reconnecting", why instanceof Error ? why.message : why);
    scheduleRetry();
  };

  const scheduleRetry = () => {
    if (closed || retry) return;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.min(failures, 10));
    failures++;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, delay);
    retry.unref?.();
  };

  const open = () => {
    const c = new Client({ connectionString: url, keepAlive: true, keepAliveInitialDelayMillis: 10_000, application_name: "portal-runs-listener" });
    c.on("error", (err) => lost(c, err));
    c.on("end", () => lost(c, "connection ended"));
    c.on("notification", (msg) => {
      if (msg.channel !== RUN_CHANNEL) return;
      const sig = parseRunSignal(msg.payload);
      if (sig) deliver(sig);
    });
    return c;
  };

  const connect = async () => {
    if (closed || client || connecting) return;
    connecting = true;
    let c: Client | undefined;
    try {
      c = open();
      await c.connect();
      await c.query(`LISTEN ${RUN_CHANNEL}`);
    } catch (err) {
      connecting = false;
      if (c) drop(c);
      if (closed) return;
      if (failures === 0 || failures % 10 === 0) console.warn("[runs] run listener can't connect, retrying", err instanceof Error ? err.message : err);
      scheduleRetry();
      return;
    }
    connecting = false;
    if (closed) return drop(c);
    client = c;
    failures = 0;
    ping = setInterval(() => void check(c), PING_MS);
    ping.unref?.();
    if (connectedOnce) console.info("[runs] run listener reconnected");
    connectedOnce = true;
    for (const w of readyWaiters) w.resolve();
    readyWaiters = [];
    wakeAll();
  };

  /** A half-open connection can hang a query forever: a ping that doesn't answer in time counts as lost. */
  const check = async (c: Client) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        c.query("SELECT 1"),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("ping timed out")), PING_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      lost(c, err);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Connects on first use; while a reconnect is pending, it waits for the backoff. */
  const ensure = () => {
    if (!closed && !client && !connecting && !retry) void connect();
  };

  const listener: RunListener = {
    subscribe(runId, fn) {
      let set = subs.get(runId);
      if (!set) subs.set(runId, (set = new Set()));
      set.add(fn);
      ensure();
      return () => {
        const cur = subs.get(runId);
        if (!cur) return;
        cur.delete(fn);
        if (!cur.size) subs.delete(runId);
      };
    },
    subscribeAll(fn) {
      all.add(fn);
      ensure();
      return () => {
        all.delete(fn);
      };
    },
    wait(runId, ms, signal) {
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve("aborted");
        let settled = false;
        let unsubscribe = () => {};
        const finish = (v: "signal" | "timeout" | "aborted") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", onAbort);
          resolve(v);
        };
        const onAbort = () => finish("aborted");
        const timer = setTimeout(() => finish("timeout"), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        unsubscribe = listener.subscribe(runId, () => finish("signal"));
      });
    },
    ready() {
      if (client) return Promise.resolve();
      if (closed) return Promise.reject(new Error("run listener closed"));
      const p = new Promise<void>((resolve, reject) => readyWaiters.push({ resolve, reject }));
      ensure();
      return p;
    },
    async close() {
      if (closed) return;
      closed = true;
      if (retry) clearTimeout(retry);
      retry = null;
      if (ping) clearInterval(ping);
      ping = null;
      for (const w of readyWaiters) w.reject(new Error("run listener closed"));
      readyWaiters = [];
      subs.clear();
      all.clear();
      const c = client;
      client = null;
      if (c) {
        c.removeAllListeners("notification");
        c.removeAllListeners("end");
        c.on("error", () => {});
        await c.end().catch(() => {});
      }
    },
  };
  return listener;
}
