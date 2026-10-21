import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import type { extractText as ExtractText } from "@/lib/files/extract";

class SyntheticChild extends EventEmitter {
  stdout = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: () => {} });
  closed = false;
  kill = () => true;
  complete() {
    if (this.closed) return;
    this.closed = true;
    this.stdout.emit("data", Buffer.from('"fixture"'));
    this.emit("close", 0, null);
  }
}
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("reserves a released extraction slot for its queued waiter before admitting a new caller", async () => {
  // Execute the unchanged production module with synthetic spawn only. No parser process or network is started.
  const children: SyntheticChild[] = [];
  const moduleFixture = { exports: {} as { extractText: typeof ExtractText } };
  const source = readFileSync("src/lib/files/extract.ts", "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { module: moduleFixture, exports: moduleFixture.exports, Buffer, console, setTimeout, clearTimeout,
    process: { execPath: "synthetic", cwd: () => ".", env: {} },
    require: (id: string) => {
      expect(id).toBe("node:child_process");
      return { spawn: () => { const child = new SyntheticChild(); children.push(child); return child; } };
    },
  });
  const start = (name: string) => moduleFixture.exports.extractText(Buffer.from(name), "application/pdf", `${name}.pdf`);
  const pending = [start("first"), start("second")];
  try {
    await turn();
    expect(children).toHaveLength(2);
    pending.push(start("queued"));
    children[0].complete();
    // Reproduce a new upload arriving after release but before the queued extraction's continuation.
    queueMicrotask(() => pending.push(start("new-arrival")));
    await turn();
    expect(children.filter((child) => !child.closed)).toHaveLength(2);
    expect(children).toHaveLength(3);
  } finally {
    // Complete later handoffs even when a negative-control assertion fails; leave no extraction timers alive.
    for (let i = 0; i < 4; i++) { children.forEach((child) => child.complete()); await turn(); }
    expect(await Promise.all(pending)).toEqual(["fixture", "fixture", "fixture", "fixture"]);
  }
});
