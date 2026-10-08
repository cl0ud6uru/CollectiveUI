import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { runEvents, startRun } from "@/lib/llm/providers/hermes/client";

// Explicit opt-in runtime with aiohttp. No production addresses, profiles, or data.
it.skipIf(!process.env.HERMES_ATTACHMENTS_PYTHON)("delivers exact document and image bytes over HTTP to readable server-side paths before run admission", async () => {
  const child = spawn(process.env.HERMES_ATTACHMENTS_PYTHON!, ["-B", "tests/fixtures/hermes-attachments-http.py"], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let errors = "";
  child.stderr.on("data", chunk => { errors += String(chunk); });
  try {
    const port = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line).port as number),
      once(child, "exit").then(() => { throw new Error("Synthetic server failed to start: " + errors); }),
    ]);
    const target = { baseUrl: `http://127.0.0.1:${port}`, profile: "synthetic", apiKey: "synthetic-api-key" };
    const originals = [
      { name: "example.doc", mediaType: "application/msword", data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0xff]) },
      { name: "example.pdf", mediaType: "application/pdf", data: Buffer.from("%PDF synthetic fixture") },
      { name: "example.png", mediaType: "image/png", data: Buffer.from([137, 80, 78, 71, 0, 0xff]) },
    ];
    const request = { input: "Read the originals.", sessionId: "synthetic-conversation", sessionKey: "synthetic-owner", idempotencyKey: "synthetic-run",
      attachments: originals.map(f => ({ name: f.name, mediaType: f.mediaType, contentBase64: f.data.toString("base64") })) };
    const runId = await startRun(target, request);
    const events = [];
    for await (const event of runEvents(target, runId)) events.push(event);
    expect(JSON.parse(String(events.at(-1)!.output))).toEqual(originals.map(f => ({ name: f.name, sha256: createHash("sha256").update(f.data).digest("hex") })));
    // The same upload receipts remain readable on retries, rather than one-shot consumption.
    expect(await startRun(target, request)).toBe(runId);
    // IDs from one profile cannot be bound by another. Direct wire attempt exercises the real adapter.
    const upload = await fetch(`${target.baseUrl}/p/synthetic/v1/attachments`, { method: "POST", body: new Uint8Array(originals[0].data),
      headers: { Authorization: "Bearer synthetic-api-key", "Content-Type": "application/msword", "X-Hermes-Filename": "example.doc",
        "X-Hermes-Session-Id": request.sessionId, "X-Hermes-Session-Key": request.sessionKey, "Idempotency-Key": "synthetic-cross-profile" } });
    const receipt = await upload.json();
    const rejected = await fetch(`${target.baseUrl}/p/other/v1/runs`, { method: "POST",
      headers: { Authorization: "Bearer synthetic-api-key", "Content-Type": "application/json", "X-Hermes-Session-Key": request.sessionKey },
      body: JSON.stringify({ input: "Read it.", session_id: request.sessionId, file_ids: [receipt.id] }) });
    expect(rejected.status).toBe(404);
    const unauthorized = await fetch(`${target.baseUrl}/p/synthetic/v1/attachments`, { method: "POST", body: "synthetic", headers: { Authorization: "Bearer wrong-key" } });
    expect(unauthorized.status).toBe(401);
  } finally {
    lines.close();
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
  }
}, 15000);
