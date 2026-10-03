import { describe, expect, it } from "vitest";
import { assertSecret, HEADER_NONCE, HEADER_SIG, HEADER_TS, MAX_SKEW_MS, NonceCache, signRequest, verifyRequest } from "@/sandboxd/protocol/auth";
import { encodeFrame, LineSplitter, parseFrame, type Frame } from "@/sandboxd/protocol/frames";
import { dockerFrame, DockerDemuxer, type StreamType } from "@/sandboxd/demux";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000_000;

describe("sandboxd request signing", () => {
  const signed = (over: { method?: string; path?: string; body?: string; now?: number } = {}) => {
    const req = { method: "POST", path: "/v1/sandboxes/abc/exec?x=1", body: '{"a":1}', now: NOW, ...over };
    return { req, headers: signRequest(SECRET, req) };
  };
  const verify = (headers: Record<string, string | undefined>, over: Partial<{ method: string; path: string; body: string; now: number; nonces: NonceCache; secret: string }> = {}) =>
    verifyRequest(over.secret ?? SECRET, {
      method: over.method ?? "POST",
      path: over.path ?? "/v1/sandboxes/abc/exec?x=1",
      body: over.body ?? '{"a":1}',
      headers,
      now: over.now ?? NOW,
      nonces: over.nonces ?? new NonceCache(),
    });

  it("accepts a correctly signed request once", () => {
    const { headers } = signed();
    const nonces = new NonceCache();
    expect(verify(headers, { nonces })).toEqual({ ok: true });
    expect(verify(headers, { nonces })).toEqual({ ok: false, reason: "replay" });
  });

  it("rejects any change to method, path, query or body, and a wrong secret", () => {
    const { headers } = signed();
    expect(verify(headers, { method: "GET" }).ok).toBe(false);
    expect(verify(headers, { path: "/v1/sandboxes/abd/exec?x=1" }).ok).toBe(false);
    expect(verify(headers, { path: "/v1/sandboxes/abc/exec?x=2" }).ok).toBe(false);
    expect(verify(headers, { body: '{"a":2}' })).toEqual({ ok: false, reason: "signature" });
    expect(verify(headers, { secret: "t".repeat(40) })).toEqual({ ok: false, reason: "signature" });
  });

  it("rejects stale or future timestamps, and malformed or missing headers", () => {
    const { headers } = signed();
    expect(verify(headers, { now: NOW + MAX_SKEW_MS + 1 })).toEqual({ ok: false, reason: "skew" });
    expect(verify(headers, { now: NOW - MAX_SKEW_MS - 1 })).toEqual({ ok: false, reason: "skew" });
    expect(verify({ ...headers, [HEADER_SIG]: undefined })).toEqual({ ok: false, reason: "missing" });
    expect(verify({ ...headers, [HEADER_NONCE]: "short" })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ ...headers, [HEADER_TS]: "12ab" })).toEqual({ ok: false, reason: "malformed" });
    expect(verify({ ...headers, [HEADER_SIG]: "Z".repeat(64) })).toEqual({ ok: false, reason: "malformed" });
  });

  it("a forged request doesn't use up a nonce", () => {
    const nonces = new NonceCache();
    const { headers } = signed();
    expect(verify({ ...headers, [HEADER_SIG]: "0".repeat(64) }, { nonces }).ok).toBe(false);
    expect(verify(headers, { nonces })).toEqual({ ok: true });
  });

  it("nonces expire after the replay window, and a full cache refuses", () => {
    const c = new NonceCache(1000, 2);
    expect(c.claim("a".repeat(16), 0)).toBe(true);
    expect(c.claim("b".repeat(16), 0)).toBe(true);
    expect(c.claim("c".repeat(16), 0)).toBe(false); // full
    expect(c.claim("a".repeat(16), 2000)).toBe(true); // expired and pruned
  });

  it("refuses short secrets", () => {
    expect(() => assertSecret("x".repeat(31))).toThrow(/at least 32/);
    expect(() => assertSecret(undefined)).toThrow();
    expect(() => assertSecret("x".repeat(32))).not.toThrow();
  });
});

describe("exec stream frames", () => {
  it("round-trips frames and splits lines across chunks", () => {
    const frames: Frame[] = [
      { t: "start", id: "abcdefgh12345678" },
      { t: "out", d: Buffer.from("hi\n").toString("base64") },
      { t: "hb" },
      { t: "exit", code: 0, reason: "exited", ms: 12, dropped: { out: 0, err: 0 } },
    ];
    const wire = frames.map(encodeFrame).join("");
    const split = new LineSplitter();
    const lines = [...split.push(wire.slice(0, 7)), ...split.push(wire.slice(7, 40)), ...split.push(wire.slice(40))];
    expect(split.end()).toBe("");
    expect(lines.map(parseFrame)).toEqual(frames);
  });

  it("rejects malformed frames", () => {
    expect(() => parseFrame('{"t":"exit","code":"0"}')).toThrow();
    expect(() => parseFrame('{"t":"nope"}')).toThrow();
    expect(() => parseFrame("not json")).toThrow();
  });
});

describe("Docker stream demuxer", () => {
  const collect = (chunks: Buffer[]) => {
    const got: [StreamType, string][] = [];
    const d = new DockerDemuxer((t, data) => {
      const last = got.at(-1);
      if (last && last[0] === t) last[1] += data.toString();
      else got.push([t, data.toString()]);
    });
    for (const c of chunks) d.push(c);
    return { got, clean: d.clean };
  };
  const stream = Buffer.concat([dockerFrame(1, "hello "), dockerFrame(2, "oops"), dockerFrame(1, "world"), dockerFrame(3, "daemon says no")]);

  it("handles a split at every byte position, including inside headers", () => {
    for (let i = 1; i < stream.length; i++) {
      const { got, clean } = collect([stream.subarray(0, i), stream.subarray(i)]);
      expect(clean).toBe(true);
      expect(got).toEqual([
        [1, "hello "],
        [2, "oops"],
        [1, "world"],
        [3, "daemon says no"],
      ]);
    }
  });

  it("streams byte by byte and large frames without buffering them whole", () => {
    const big = Buffer.alloc(1_000_000, 0x61);
    const { got } = collect([...Buffer.concat([dockerFrame(1, big)])].map((b) => Buffer.from([b])).slice(0, 20));
    expect(got[0][1].length).toBe(12); // 8 header bytes + 12 payload bytes so far
    const whole = collect([dockerFrame(1, big)]);
    expect(whole.got[0][1].length).toBe(1_000_000);
  });

  it("reports an unfinished stream and rejects unknown stream types", () => {
    expect(collect([stream.subarray(0, stream.length - 3)]).clean).toBe(false);
    const bad = dockerFrame(1, "x");
    bad[0] = 9;
    expect(() => collect([bad])).toThrow(/stream type/);
  });
});
