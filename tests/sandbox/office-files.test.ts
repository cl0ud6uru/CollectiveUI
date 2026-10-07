import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enabled, newRef, run, startSandboxd, type Harness } from "./harness";

(enabled ? describe : describe.skip)("Office files in fresh offline workspaces", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startSandboxd({ SANDBOXD_IMAGE: process.env.OFFICE_TEST_IMAGE ?? "ai-portal-sandbox:p5",
      SANDBOXD_MEMORY_MB: "1024", SANDBOXD_PIDS: "256", SANDBOXD_TMP_MB: "256", SANDBOXD_MAX_EXEC_SECONDS: "120" });
  });
  afterAll(async () => { await h?.close(); });
  it("round-trips Word, Excel, PowerPoint and PDF with verified conversions and preserved originals", async () => {
    const ref = newRef();
    const bytes = readFileSync(new URL("../fixtures/office-files.py", import.meta.url));
    await h.client.writeFile(ref, { isolation: "any", path: "office-files.py", contentB64: bytes.toString("base64") });
    const result = await run(h, ref, "/opt/office/bin/python office-files.py", { timeoutMs: 120_000 });
    expect(result, result.out + result.err).toMatchObject({ code: 0, reason: "exited" });
    expect(result.out).toContain('"originals_preserved": true');
    for (const path of ["edited.docx", "edited-budget.xlsx", "edited-slides.pptx", "merged.pdf", "split.pdf"]) {
      const file = await h.client.readFile(ref, { isolation: "any", path: `office-output/synthetic/${path}`, maxBytes: 10 * 1024 * 1024 });
      expect(file?.size).toBeGreaterThan(0);
      expect(file?.truncated).toBe(false);
      expect(file?.bytes.subarray(0, 2).toString()).toBe(path.endsWith(".pdf") ? "%P" : "PK");
    }
    // Downloads/imports use a caller-bound workspace; another workspace cannot read those paths.
    const other = newRef();
    await h.client.start(other, "any");
    expect(await h.client.readFile(other, { isolation: "any", path: "office-output/synthetic/edited.docx", maxBytes: 1024 })).toBeNull();
    const isolation = await run(h, ref, "/opt/office/bin/python -c 'import socket; s=socket.socket(); s.settimeout(1); print(s.connect_ex((\"1.1.1.1\", 443)) != 0)' ");
    expect(isolation.out.trim()).toBe("True");
  });
});
