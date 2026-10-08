import { describe, expect, it, vi } from "vitest";
import { capResult, cleanDescription, mcpResultToModelOutput, MAX_DESCRIPTION_CHARS, stripHidden } from "@/lib/mcp/hygiene";
import { redactMcpSecrets, redactMcpValue } from '@/lib/mcp/client';
import { AAD, encrypt } from '@/lib/crypto';

const TAGS = "\u{E0049}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}"; // "Ignore" in Unicode tag characters

describe('MCP credential echo cleaning', () => {
  it.each(['Bearer', 'Basic'])('masks normalized %s wire headers and bare tokens from legacy shared storage', scheme => {
    vi.stubEnv('ENCRYPTION_KEY', 'synthetic-shared-echo-fixture-only'); vi.stubEnv('ENCRYPTION_KEYS', ''); vi.stubEnv('ENCRYPTION_PRIMARY_KID', '');
    try {
      const token = 'shared-trim-secret-74381', stored = `  ${scheme} ${token}  `;
      const server = { id: 'synthetic-shared', headersEnc: encrypt(JSON.stringify({ Authorization: stored }), AAD.mcpHeaders), identitySecretEnc: null };
      const result = { content: [{ type: 'text', text: `echo ${stored} ${scheme} ${token} ${token}` }], structuredContent: { [token]: token } };
      const clean = redactMcpValue(result, server);
      expect(JSON.stringify(clean)).not.toContain(token); expect(clean.content[0].text).toContain('[redacted]');
      expect(clean.structuredContent).toEqual({ '[redacted]': '[redacted]' });
    } finally { vi.unstubAllEnvs(); }
  });
  it('retains unrelated text and ignores empty normalization masks', () => {
    expect(redactMcpSecrets({ text: 'normal result' }, ['', '   '])).toEqual({ text: 'normal result' });
  });
});

describe("MCP text cleaning", () => {
  it("strips characters that hide text from reviewers, and keeps normal text and emoji", () => {
    expect(stripHidden(`Look up${TAGS} a user`)).toBe("Look up a user");
    expect(stripHidden("a\u202Eb\u2066c\u200Bd\uFEFFe")).toBe("abcde");
    expect(stripHidden("x\u{E0101}y")).toBe("xy");
    const family = "👨\u200D👩\u200D👧";
    expect(stripHidden(`${family} ❤️ café`)).toBe(`${family} ❤️ café`);
  });

  it("caps descriptions", () => {
    expect(cleanDescription(` ${"a".repeat(MAX_DESCRIPTION_CHARS + 10)} `)).toHaveLength(MAX_DESCRIPTION_CHARS + 1);
    expect(cleanDescription(undefined)).toBeUndefined();
  });
});

describe("MCP result limit", () => {
  it("charges metadata and the entire serialized JSON envelope to the byte budget", () => {
    const r = capResult({ extra: 'z'.repeat(90000), content: [{ type: 'text', text: 'hi', annotations: { extra: 'x'.repeat(90000) } }] }, 100);
    expect(Buffer.byteLength(JSON.stringify(r), 'utf8')).toBeLessThanOrEqual(100);
    expect(r).toEqual({ content: [{ type: 'text', text: 'hi' }] });
  });
  it.each([
    { content: [{ type: 'text', text: '漢😀\\\"\n'.repeat(1000) }] },
    { content: Array.from({ length: 10000 }, () => ({ type: 'image', data: 'A'.repeat(1000), mimeType: 'image/png', extra: 'x'.repeat(1000) })) },
    { content: Array.from({ length: 10000 }, () => ({ type: 'new_part', payload: 'x'.repeat(1000) })) },
    { content: Array.from({ length: 10000 }, () => ({ type: 'text', text: '' })) },
    { content: [], isError: true, structuredContent: { value: '漢'.repeat(1000) } },
  ])('bounds serialized bytes and part count for hostile results %#', (input) => {
    for (const budget of [32, 64, 100, 1024, 8192]) {
      const r = capResult(input, budget);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(budget);
      expect(r.content!.length).toBeLessThanOrEqual(64);
      if (input.isError) expect(r.isError).toBe(true);
    }
  });

  it('handles malformed JSON result shapes without dereferencing invalid parts', () => {
    for (const input of [null, 42, 'text', { content: [null] }, { content: [false] }, { content: [{ type: 'text', text: 42 }] }, { content: 'wrong', isError: true }]) {
      const r = capResult(input as never, 100);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(100);
      expect(() => mcpResultToModelOutput({ output: r })).not.toThrow();
    }
  });

  it('retains only supported resource fields in model-facing text', () => {
    const r = capResult({ content: [
      { type: 'resource_link', uri: 'x://y', name: 'name', extra: 'x'.repeat(10000) },
      { type: 'resource', resource: { uri: 'x://y', text: `ok${TAGS}`, extra: 'x'.repeat(10000) } },
    ] }, 300);
    expect(r.content).toEqual([
      { type: 'text', text: JSON.stringify({ type: 'resource_link', uri: 'x://y', name: 'name' }) },
      { type: 'text', text: JSON.stringify({ type: 'resource', resource: { uri: 'x://y', text: 'ok' } }) },
    ]);
  });

  it("passes small results through, cleaned", () => {
    expect(capResult({ content: [{ type: "text", text: `ok${TAGS}` }] }, 1000)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("cuts long text with a note and drops the parts after it", () => {
    const r = capResult({ content: [{ type: "text", text: "x".repeat(5000) }, { type: "text", text: "more" }] }, 2048);
    expect(Buffer.byteLength(JSON.stringify(r))).toBe(2048);
    expect(r.content![0].text).toMatch(/^x+$/);
    expect(r.content![1].text).toMatch(/Truncated/);
    expect(r.content).toHaveLength(2);
  });

  it("replaces images that don't fit, keeps the error flag, and drops structured content when content exists", () => {
    const r = capResult({ isError: true, structuredContent: { a: 1 }, content: [{ type: "image", data: "A".repeat(3000), mimeType: "image/png" }] }, 1024);
    expect(r).toEqual({ isError: true, content: [{ type: "text", text: expect.stringMatching(/Image omitted/) }] });
  });

  it("keeps structured-only results within the budget, and cuts ones that aren't", () => {
    expect(capResult({ content: [], structuredContent: { a: 1 } }, 100)).toEqual({ content: [], structuredContent: { a: 1 } });
    expect(JSON.stringify(capResult({ content: [], structuredContent: { a: "x".repeat(500) } }, 100))).toMatch(/Truncated/);
    expect(capResult({ toolResult: "y".repeat(500) } as never, 100).content![0].text).toMatch(/Truncated/);
  });

  it('rejects budgets that cannot fit the required envelope rather than exceeding them', () => {
    for (const budget of [0, 1, 12, -1, NaN, Infinity]) {
      expect(() => capResult({ content: [] }, budget)).toThrow(RangeError);
    }
    expect(capResult({ content: [] }, 14)).toEqual({ content: [] });
    for (const isError of [true, false]) {
      const input = { content: [], isError };
      const size = Buffer.byteLength(JSON.stringify(input));
      expect(capResult(input, size)).toEqual(input);
      expect(() => capResult(input, size - 1)).toThrow(RangeError);
    }
  });

  it('keeps small binary results with only allowlisted fields and converts images for the model', () => {
    for (const type of ['image', 'audio']) {
      const r = capResult({ isError: false, content: [{ type, data: 'AAAA', mimeType: `${type}/png`, extra: 'x'.repeat(10000) }] }, 100);
      expect(r).toEqual({ isError: false, content: [{ type, data: 'AAAA', mimeType: `${type}/png` }] });
      if (type === 'image') expect(mcpResultToModelOutput({ output: r })).toEqual({ type: 'content', value: [
        { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AAAA' } },
      ] });
    }
  });

  it('charges binary mimeType metadata and stops reading after the first omission', () => {
    const later = { get type(): string { throw new Error('must not inspect omitted tail'); } };
    const r = capResult({ content: [{ type: 'image', data: 'A', mimeType: 'x'.repeat(10000) }, later] }, 100);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(100);
    expect(r.content).toHaveLength(1);
    expect(r.content![0].text).toMatch(/Image omitted/);
  });

  it('preserves structured-only error semantics and does not resurrect structured data after omitted content', () => {
    const r = capResult({ isError: true, structuredContent: { value: `ok${TAGS}` } }, 100);
    expect(r).toEqual({ content: [], isError: true, structuredContent: { value: 'ok' } });
    expect(mcpResultToModelOutput({ output: r })).toEqual({ type: 'json', value: { value: 'ok' } });
    const omitted = capResult({ isError: true, structuredContent: { hidden: true }, content: [{ type: 'image', data: 'A'.repeat(1000), mimeType: 'image/png' }] }, 32);
    expect(omitted).toEqual({ content: [], isError: true });
    expect(mcpResultToModelOutput({ output: omitted })).toEqual({ type: 'content', value: [] });
  });

  it('does not split emoji while truncating serialized escaped and multibyte text', () => {
    for (let budget = 80; budget < 100; budget++) {
      const r = capResult({ content: [{ type: 'text', text: '😀'.repeat(100) }] }, budget);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(budget);
      expect(r.content![0].text).toMatch(/^(?:😀)*$/u);
    }
  });

  it("maps results for the model like @ai-sdk/mcp does", () => {
    expect(
      mcpResultToModelOutput({
        output: { content: [{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "resource_link", uri: "x://y" }] },
      }),
    ).toEqual({
      type: "content",
      value: [
        { type: "text", text: "hi" },
        { type: "file", mediaType: "image/png", data: { type: "data", data: "AAAA" } },
        { type: "text", text: JSON.stringify({ type: "resource_link", uri: "x://y" }) },
      ],
    });
    expect(mcpResultToModelOutput({ output: { content: [], structuredContent: { a: 1 } } })).toEqual({ type: "json", value: { a: 1 } });
  });
});
