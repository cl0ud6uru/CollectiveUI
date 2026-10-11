import { readFileSync, readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { streamText } from "ai";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { RunHandle } from "@/lib/runs/types";
import { HermesError, HermesPreAdmissionError, startRun, type HermesTarget } from "@/lib/llm/providers/hermes/client";
import { HermesLanguageModel } from "@/lib/llm/providers/hermes/model";

const fixture = vi.hoisted(() => ({ client: null as PGlite | null }));
vi.mock("@/db", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@/db/schema");
  fixture.client = new PGlite();
  return { db: drizzle(fixture.client, { schema }), schema };
});
vi.mock("@/lib/jobs", () => ({ scheduleMemoryExtraction: vi.fn(), enqueueRun: vi.fn() }));
vi.mock("@/lib/runs/hooks", () => ({ afterRunTransition: vi.fn() }));
vi.mock("@/lib/llm/resolve", () => ({ hermesTargetFor: vi.fn(() => { throw new Error("No live Hermes calls permitted"); }) }));

import { db, schema } from "@/db";
import { hermesAdmissionRecorder, noteHermesAdmission } from "@/lib/runs/hermes-admission";
import { assertHermesIdle } from "@/lib/runs/hermes-context";
import { reconcileHermesStop } from "@/lib/runs/hermes-stop";
import { noteRunResumeState } from "@/lib/runs/state";

const binding = { targetKey: "synthetic-binding", model: null, provisionId: null };
const file = { name: "example.doc", mediaType: "application/msword", contentBase64: Buffer.from("synthetic file").toString("base64") };
const request = { input: "Review", attachments: [file], sessionId: "synthetic-session", sessionKey: "synthetic-scope", idempotencyKey: "portal-run" };
let calls: string[], supported: boolean, outcome: "ok" | "timeout" | "missing-id";
const target: HermesTarget = { baseUrl: "https://hermes.example.test", profile: "", apiKey: "synthetic-key",
  fetch: (async input => {
    const path = new URL(String(input)).pathname; calls.push(path);
    if (path === "/v1/capabilities") return Response.json({ features: supported ? { run_attachments: { version: 1 } } : {} });
    if (path === "/v1/runs") {
      if (outcome === "timeout") throw new Error("Synthetic lost response after admission");
      return Response.json(outcome === "missing-id" ? {} : { run_id: "synthetic-upstream" });
    }
    throw new Error("Unexpected fixture request");
  }) as typeof fetch };

beforeAll(async () => {
  await fixture.client!.waitReady;
  for (const name of readdirSync("src/db/migrations").filter(f => f.endsWith(".sql")).sort())
    await fixture.client!.exec(readFileSync(`src/db/migrations/${name}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS vector;", "").replace(/\bvector\b/g, "real[]"));
}, 45000);
beforeEach(async () => {
  await db.delete(schema.users);
  await db.insert(schema.users).values({ id: "user", upn: "synthetic@example.test", name: "Synthetic", authSource: "ldap" });
  await db.insert(schema.conversations).values({ id: "chat", userId: "user" });
  calls = []; supported = false; outcome = "ok";
});
afterAll(async () => { await fixture.client?.close(); });

async function createRun(id = "run", admissionState: "prepared" | "attempted" | "rejected" | null = "prepared", extra = {}) {
  const [run] = await db.insert(schema.agentRuns).values({ id, userId: "user", conversationId: "chat", messageId: `${id}-message`,
    status: "running", holder: "worker", startedAt: new Date(), ...extra }).returning();
  await db.insert(schema.hermesRunContexts).values({ runId: id, ...binding, admissionState });
  return run;
}
const context = async (id = "run") => (await db.select().from(schema.hermesRunContexts).where(eq(schema.hermesRunContexts.runId, id)))[0];
async function finish(id = "run") {
  return (await db.update(schema.agentRuns).set({ status: "failed", holder: null, resumeState: null }).where(eq(schema.agentRuns.id, id)).returning())[0];
}
const idle = () => db.transaction(tx => assertHermesIdle(tx, "chat"));

describe("durable Hermes non-admission recovery", () => {
  it.each(["before", "after"])("unsupported originals recover even when Stop writes pending %s proof", async timing => {
    const run = await createRun();
    if (timing === "before") await reconcileHermesStop(run, true);
    const handle: RunHandle = { id: run.id, segment: 0, legacy: false, resumeState: null, hermes: binding, saveResumeState: () => {},
      noteHermesAdmission: s => noteHermesAdmission(run.id, "worker", 0, binding, s) };
    const model = new HermesLanguageModel("synthetic", { target, sessionId: request.sessionId, sessionKey: request.sessionKey,
      interactive: true, approvalTimeoutSec: 300, run: handle });
    const stream = streamText({ model, messages: [{ role: "user", content: [
      { type: "text", text: "Review" }, { type: "file", filename: file.name, mediaType: file.mediaType, data: Buffer.from(file.contentBase64, "base64") },
    ] }] });
    const errors = [];
    for await (const part of stream.fullStream) if (part.type === "error") errors.push(part.error);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HermesPreAdmissionError);
    expect(String(errors[0])).toContain("No files or prompt were sent");
    expect(calls).toEqual(["/v1/capabilities"]);
    expect((await context()).admissionState).toBe("rejected");
    await expect(idle()).rejects.toMatchObject({ status: 409 }); // Worker still holds the chat.
    if (timing === "after") await reconcileHermesStop(run, true);
    const terminal = await finish();
    expect(await reconcileHermesStop(terminal, true)).toContain("before Hermes started");
    expect((await context()).stopState).toBe("confirmed");
    await expect(idle()).resolves.toBeUndefined();
    expect(calls).toEqual(["/v1/capabilities"]);
  });

  it.each(["timeout", "missing-id"] as const)("keeps %s after the POST fenced, including a later preflight rejection", async mode => {
    await createRun(); outcome = mode;
    await expect(startRun(target, { ...request, attachments: [], beforeAdmission: () => noteHermesAdmission("run", "worker", 0, binding, "attempted") }))
      .rejects.toBeInstanceOf(HermesError);
    expect((await context()).admissionState).toBe("attempted");
    await expect(startRun(target, request)).rejects.toBeInstanceOf(HermesPreAdmissionError);
    await noteHermesAdmission("run", "worker", 0, binding, "rejected");
    expect((await context()).admissionState).toBe("attempted");
    expect(await reconcileHermesStop(await finish(), true)).toContain("identity is not recorded");
    await expect(idle()).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual(["/v1/runs", "/v1/capabilities"]);
  });

  it.each(["holder", "segment", "legacy", "target", "provision", "upstream", "resume", "historical"])("does not accept false proof with %s mismatch", async mismatch => {
    await createRun("run", mismatch === "historical" ? null : "prepared", mismatch === "legacy" ? { legacy: true } : mismatch === "segment" ? { segment: 1 } : {});
    if (mismatch === "upstream") await db.update(schema.hermesRunContexts).set({ upstreamRunId: "retained-upstream" });
    if (mismatch === "resume") await noteRunResumeState("run", "worker", { hermes: { runId: "retained-upstream" } });
    const captured = { ...binding, ...(mismatch === "target" ? { targetKey: "changed" } : {}), ...(mismatch === "provision" ? { provisionId: "changed" } : {}) };
    await noteHermesAdmission("run", mismatch === "holder" ? "stale-worker" : "worker", mismatch === "segment" ? 1 : 0, captured, "rejected").catch(() => {});
    expect((await context()).admissionState).not.toBe("rejected");
    const terminal = await finish();
    await reconcileHermesStop(terminal, true);
    expect((await context()).stopState).toBe("pending");
    await expect(idle()).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
  });

  it("prevents a Runs POST after a failed admission fence", async () => {
    await createRun();
    await expect(startRun(target, { ...request, attachments: [], beforeAdmission: () => noteHermesAdmission("run", "stale-worker", 0, binding, "attempted") })).rejects.toThrow(/lease/);
    expect(calls).toEqual([]);
    expect((await context()).admissionState).toBe("prepared");
  });

  it("cannot resubmit a durably rejected identity", async () => {
    await createRun(); await noteHermesAdmission("run", "worker", 0, binding, "rejected");
    await expect(startRun(target, { ...request, attachments: [], beforeAdmission: () => noteHermesAdmission("run", "worker", 0, binding, "attempted") })).rejects.toThrow(/closed/);
    expect(calls).toEqual([]);
  });

  it("does not unlock an older pending run in the same chat", async () => {
    await createRun("older", null, { status: "failed", holder: null });
    await db.update(schema.hermesRunContexts).set({ stopState: "pending" }).where(eq(schema.hermesRunContexts.runId, "older"));
    await createRun(); await noteHermesAdmission("run", "worker", 0, binding, "rejected");
    await reconcileHermesStop(await finish(), true);
    expect((await context()).stopState).toBe("confirmed");
    expect((await context("older")).stopState).toBe("pending");
    await expect(idle()).rejects.toMatchObject({ status: 409 });
  });

  it("preserves native Team model dispatch without a remote context", async () => {
    const handle: RunHandle = { id: "team-run", segment: 0, legacy: false, resumeState: null, saveResumeState: () => {},
      noteProviderRun: vi.fn(), noteHermesAdmission: hermesAdmissionRecorder("team-run", "worker", 0, undefined) };
    expect(handle.noteHermesAdmission).toBeUndefined();
    const wire = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/v1/runs") ? Response.json({ run_id: "team-upstream" }) :
      new Response('data: {"event":"run.completed","output":"Team result","usage":{}}\n\n', { headers: { "Content-Type": "text/event-stream" } }));
    const model = new HermesLanguageModel("team-model", { target: { ...target, local: true, fetch: wire as typeof fetch },
      sessionId: "team-session", sessionKey: "team-scope", interactive: true, approvalTimeoutSec: 90, run: handle });
    expect(await streamText({ model, prompt: "Synthetic team request" }).text).toBe("Team result");
    expect(String(wire.mock.calls[0][0])).toMatch(/\/v1\/runs$/);
    expect(handle.noteProviderRun).toHaveBeenCalledWith({ hermes: { runId: "team-upstream" } });
    expect(await context("team-run")).toBeUndefined();
  });

  it("preserves the delivery error when proof persistence fails and keeps the fence", async () => {
    await createRun();
    const proof = vi.fn(async () => { throw new Error("Synthetic lost lease"); });
    const model = new HermesLanguageModel("synthetic", { target, sessionId: request.sessionId, sessionKey: request.sessionKey,
      interactive: true, approvalTimeoutSec: 300, run: { id: "run", segment: 0, legacy: false, resumeState: null,
        saveResumeState: () => {}, noteHermesAdmission: proof } });
    const stream = streamText({ model, messages: [{ role: "user", content: [
      { type: "file", filename: file.name, mediaType: file.mediaType, data: Buffer.from(file.contentBase64, "base64") },
    ] }] });
    const errors = [];
    for await (const part of stream.fullStream) if (part.type === "error") errors.push(part.error);
    expect(String(errors[0])).toContain("No files or prompt were sent");
    expect(proof).toHaveBeenCalledWith("rejected");
    expect((await context()).admissionState).toBe("prepared");
    await reconcileHermesStop(await finish(), true);
    await expect(idle()).rejects.toMatchObject({ status: 409 });
  });

  it("checks retained identity again at cleanup and keeps it fenced", async () => {
    await createRun(); await noteHermesAdmission("run", "worker", 0, binding, "rejected");
    await db.update(schema.hermesRunContexts).set({ upstreamRunId: "synthetic-retained-id" });
    await reconcileHermesStop(await finish(), true);
    expect((await context()).stopState).toBe("pending");
    await expect(idle()).rejects.toMatchObject({ status: 409 });
  });
});
