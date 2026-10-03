import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunListener } from "@/lib/runs/listener";
import { RUN_CHANNEL } from "@/lib/runs/types";

const run = process.env.DATABASE_URL ? describe : describe.skip;

run("run listener (integration)", () => {
  const url = process.env.DATABASE_URL!;
  const tag = `${process.pid}-${Date.now()}`;
  // Each instance gets its own application_name so the test can find (and kill) its backend.
  const named = (name: string) => {
    const u = new URL(url);
    u.searchParams.set("application_name", name);
    return u.toString();
  };
  const nameA = `it-runs-a-${tag}`;
  const nameB = `it-runs-b-${tag}`;
  let a: RunListener;
  let b: RunListener;
  let sql: Client;

  const notify = (payload: string) => sql.query("select pg_notify($1, $2)", [RUN_CHANNEL, payload]);
  const signal = (r: string, k = "e") => notify(JSON.stringify({ r, k }));
  const until = async (cond: () => boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  beforeAll(async () => {
    const { createRunListener } = await import("@/lib/runs/listener");
    a = createRunListener(named(nameA));
    b = createRunListener(named(nameB));
    sql = new Client({ connectionString: url });
    await sql.connect();
    await Promise.all([a.ready(), b.ready()]);
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await sql?.end();
  });

  it("both instances receive a signal; malformed payloads are ignored", async () => {
    const runId = `run-${tag}-1`;
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const seenAll: unknown[] = [];
    const offA = a.subscribe(runId, (s) => seenA.push(s));
    const offB = b.subscribe(runId, (s) => seenB.push(s));
    const offAll = a.subscribeAll((s) => {
      if (s.r === runId) seenAll.push(s);
    });
    await notify("not json");
    await notify(JSON.stringify({ r: runId, k: "zz" }));
    await notify(JSON.stringify({ r: runId, k: "c", extra: "<script>" }));
    await signal(runId, "e");
    await until(() => seenA.length >= 2 && seenB.length >= 2 && seenAll.length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(seenA).toEqual([
      { r: runId, k: "c" },
      { r: runId, k: "e" },
    ]);
    expect(seenB).toEqual(seenA);
    expect(seenAll).toEqual(seenA);
    offA();
    offB();
    offAll();
    // Unsubscribed: nothing more arrives.
    await signal(runId, "t");
    await new Promise((r) => setTimeout(r, 200));
    expect(seenA).toHaveLength(2);
  });

  it("reconnects after its backend is terminated, wakes subscribers, and listens again", async () => {
    const runId = `run-${tag}-2`;
    const seenA: { k: string }[] = [];
    const seenAll: { r: string; k: string }[] = [];
    const seenB: { k: string }[] = [];
    a.subscribe(runId, (s) => seenA.push(s));
    a.subscribeAll((s) => seenAll.push(s));
    b.subscribe(runId, (s) => seenB.push(s));
    const { rows } = await sql.query("select pg_terminate_backend(pid) as killed from pg_stat_activity where application_name = $1", [nameA]);
    expect(rows).toEqual([{ killed: true }]);
    await until(() => seenA.some((s) => s.k === "reconnect"));
    expect(seenAll).toContainEqual({ r: "*", k: "reconnect" });
    // The other instance kept its connection.
    expect(seenB).toEqual([]);
    await signal(runId, "q");
    await until(() => seenA.some((s) => s.k === "q") && seenB.some((s) => s.k === "q"));
    await a.ready();
  });

  it("wait() resolves on a signal, a timeout, or an abort", async () => {
    const runId = `run-${tag}-3`;
    const waiting = a.wait(runId, 10_000);
    await new Promise((r) => setTimeout(r, 50));
    await signal(runId);
    expect(await waiting).toBe("signal");

    const t0 = Date.now();
    expect(await a.wait(runId, 150)).toBe("timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);

    const ac = new AbortController();
    const aborted = a.wait(runId, 10_000, ac.signal);
    ac.abort();
    expect(await aborted).toBe("aborted");
    expect(await a.wait(runId, 10_000, ac.signal)).toBe("aborted");

    // Other runs' signals don't wake it.
    const other = a.wait(runId, 300);
    await signal(`run-${tag}-other`);
    expect(await other).toBe("timeout");
  });

  it("runListener() is one instance per process; a closed one isn't handed out again", async () => {
    const { runListener } = await import("@/lib/runs/listener");
    const l = runListener();
    expect(runListener()).toBe(l);
    await l.ready();
    await l.close();
    const again = runListener();
    expect(again).not.toBe(l);
    await again.close();
  });
});

run("run event log: writer → tails (integration)", () => {
  const tag = `${process.pid}-${Date.now()}`;
  const userId = `it-runlog-${tag}`;
  const holder = `w-it-${tag}`;
  const listenerName = `it-runlog-listener-${tag}`;
  let conversationId: string;
  const savedUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const { db } = await import("@/db");
    const { conversations, users } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    await db.insert(users).values({ id: userId, upn: `${userId}@corp.local`, name: "Run Log Test", authSource: "ldap" });
    conversationId = newId();
    await db.insert(conversations).values({ id: conversationId, userId, title: "runs" });
    // The process-wide listener the tails use gets its own name, so the test can kill exactly its backend.
    const u = new URL(savedUrl!);
    u.searchParams.set("application_name", listenerName);
    process.env.DATABASE_URL = u.toString();
  });

  afterAll(async () => {
    process.env.DATABASE_URL = savedUrl;
    const { runListener } = await import("@/lib/runs/listener");
    await runListener().close();
    const { db, pool } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(users).where(eq(users.id, userId));
    await pool.end();
  });

  it("tails see the writer's coalesced stream identically (across a listener reconnect); the fence stops a finished run", async () => {
    const { db, pool } = await import("@/db");
    const { agentRuns } = await import("@/db/schema");
    const { newId } = await import("@/lib/ids");
    const { RunEventWriter } = await import("@/lib/runs/events");
    const { readEvents } = await import("@/lib/runs/log");
    const { finalizeRunTx, requestCancelTx } = await import("@/lib/runs/state");
    const { tailRun } = await import("@/lib/runs/tail");
    const { runListener } = await import("@/lib/runs/listener");
    const { readUIMessageStream } = await import("ai");
    type Chunk = import("ai").UIMessageChunk;

    const runId = newId();
    const messageId = newId();
    await db.insert(agentRuns).values({ id: runId, userId, conversationId, messageId, status: "running", holder, heartbeatAt: new Date() });

    const collect = async (s: ReadableStream<Chunk>) => {
      const out: Chunk[] = [];
      for await (const c of s as unknown as AsyncIterable<Chunk>) out.push(c);
      return out;
    };
    await runListener().ready();
    const live = collect(tailRun(runId, { afterSeq: 0, targetSegment: 0, replay: false }));
    const replay = collect(tailRun(runId, { afterSeq: 0, targetSegment: 0, replay: true }));

    let lost = 0;
    let cancels = 0;
    const w = new RunEventWriter({ runId, segment: 0, holder, onLeaseLost: () => lost++, onCancel: () => cancels++ });
    await w.push({ type: "start", messageId });
    await w.push({ type: "data-title", data: { title: "T" }, transient: true } as Chunk);
    await w.push({ type: "start-step" });
    await w.push({ type: "text-start", id: "0" });
    const words: string[] = [];
    for (let i = 0; i < 200; i++) {
      words.push(`w${i} `);
      await w.push({ type: "text-delta", id: "0", delta: `w${i} ` });
      if (i % 40 === 39) await new Promise((r) => setTimeout(r, 150));
      if (i === 100) {
        const { rows } = await pool.query("select pg_terminate_backend(pid) as killed from pg_stat_activity where application_name = $1", [listenerName]);
        expect(rows).toEqual([{ killed: true }]);
        await db.transaction((tx) => requestCancelTx(tx, runId));
      }
    }
    await w.push({ type: "text-end", id: "0" });
    await w.push({ type: "finish-step" });
    await w.push({ type: "finish" });
    await w.close();
    expect([lost, cancels]).toEqual([0, 1]);
    const done = await db.transaction((tx) => finalizeRunTx(tx, runId, { status: ["running"], holder }, { status: "cancelled" }));
    expect(done?.status).toBe("cancelled");

    const [liveChunks, replayChunks] = await Promise.all([live, replay]);
    expect(liveChunks.filter((c) => c.type !== "data-title")).toEqual(replayChunks);
    expect(liveChunks.some((c) => c.type === "data-title")).toBe(true);
    let message;
    for await (const m of readUIMessageStream({ stream: new ReadableStream({ start: (c) => (replayChunks.forEach((x) => c.enqueue(x)), c.close()) }) }))
      message = m;
    expect(message!.parts.find((p) => p.type === "text")).toMatchObject({ text: words.join(""), state: "done" });

    // Coalesced, gap-free, one segment-end at the end.
    const rows = await readEvents(runId, 0, 1000);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
    expect(rows.length).toBeLessThan(60);
    expect(rows.at(-1)?.kind).toBe("segment-end");
    expect(rows.filter((r) => r.transient).map((r) => r.chunk?.type)).toEqual(["data-title"]);

    // A writer whose run was finished (or taken over) loses its lease and writes nothing.
    const late = new RunEventWriter({ runId, segment: 0, holder, onLeaseLost: () => lost++ });
    await late.push({ type: "start", messageId });
    await late.close();
    expect(lost).toBe(1);
    expect((await readEvents(runId, 0, 1000)).length).toBe(rows.length);
  }, 30_000);
});
