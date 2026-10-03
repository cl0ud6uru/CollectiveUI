/**
 * The exec stream: newline-delimited JSON frames. A failure before `start` is a plain HTTP error instead (the command
 * never ran, so a retry is safe).
 */

export type ExitReason = "exited" | "killed" | "timeout" | "output_limit" | "stopped" | "died";

export type Frame =
  | { t: "start"; id: string }
  | { t: "out"; d: string } // base64
  | { t: "err"; d: string } // base64
  | { t: "hb" }
  /** Output between the live head and the kept tail was dropped (n bytes of stream s). */
  | { t: "gap"; s: "out" | "err"; n: number }
  | { t: "exit"; code: number; reason: ExitReason; ms: number; dropped: { out: number; err: number } }
  | { t: "error"; code: string; message: string };

export const HEARTBEAT_MS = 15_000;
const MAX_LINE = 4 * 1024 * 1024;

export const encodeFrame = (f: Frame) => `${JSON.stringify(f)}\n`;

const REASONS = new Set<ExitReason>(["exited", "killed", "timeout", "output_limit", "stopped", "died"]);

export function parseFrame(line: string): Frame {
  const f = JSON.parse(line) as Frame;
  switch (f?.t) {
    case "start":
      if (typeof f.id === "string") return f;
      break;
    case "out":
    case "err":
      if (typeof f.d === "string") return f;
      break;
    case "hb":
      return f;
    case "gap":
      if ((f.s === "out" || f.s === "err") && typeof f.n === "number") return f;
      break;
    case "exit":
      if (typeof f.code === "number" && REASONS.has(f.reason) && typeof f.ms === "number") return f;
      break;
    case "error":
      if (typeof f.code === "string" && typeof f.message === "string") return f;
      break;
  }
  throw new Error("Malformed frame");
}

/** Splits a byte stream into lines; the remainder waits for more input. */
export class LineSplitter {
  private rest = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array | string): string[] {
    this.rest += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    if (this.rest.length > MAX_LINE) throw new Error("Frame too long");
    return lines.filter((l) => l.length > 0);
  }

  /** Whatever is left when the stream ends (a well-formed stream ends with a newline, leaving nothing). */
  end(): string {
    this.rest += this.decoder.decode();
    const rest = this.rest;
    this.rest = "";
    return rest;
  }
}
