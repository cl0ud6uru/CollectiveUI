import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
import { HermesLanguageModel } from '@/lib/llm/providers/hermes/model';
import { closeAllParked } from '@/lib/llm/providers/hermes/runs';
import type { ResumeState } from '@/lib/runs/types';
import type { HermesEvent } from '@/lib/llm/providers/hermes/client';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const frame = (event: HermesEvent, seq?: number) => `${seq !== undefined ? `id: ${seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`;
function events(frames: string[], broken = false) {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset < frames.length) controller.enqueue(new TextEncoder().encode(frames[offset++]));
    else if (broken) controller.error(new TypeError('Synthetic stream failure'));
    else controller.close();
  } }), { status: 200 });
}
function fixture(streams: (() => Response)[], status = { status: 'completed', output: 'Status result', usage: {} }) {
  const calls: { path: string; method: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname, method = init.method ?? 'GET';
    calls.push({ path, method, headers: init.headers as Record<string, string> });
    if (path.endsWith('/events')) return streams.shift()?.() ?? events([], true);
    if (method === 'POST' && path.endsWith('/runs')) return json({ run_id: 'run_synthetic' });
    if (path.endsWith('/stop')) return json({ status: 'stopping' });
    if (path.endsWith('/approval')) return json({ resolved: 1 });
    return json({ run_id: 'run_synthetic', ...status });
  }) as typeof fetch;
  return { calls, fetcher };
}
const model = (fetcher: typeof fetch, runId?: string) => new HermesLanguageModel('fixture', {
  target: { baseUrl: 'https://hermes.example.com', profile: 'fixture', apiKey: 'synthetic-key', fetch: fetcher },
  run: runId ? { id: runId, segment: 0, legacy: false, resumeState: null, saveResumeState() {} } : undefined,
  sessionId: 'session-synthetic', sessionKey: 'scope-synthetic', interactive: true, approvalTimeoutSec: 1,
});
async function run(fetcher: typeof fetch, abortSignal?: AbortSignal) {
  const result = streamText({ model: model(fetcher), prompt: 'Synthetic fixture', abortSignal });
  const parts = [];
  for await (const part of result.fullStream) parts.push(part);
  return { text: await result.text, parts, messages: (await result.response).messages };
}
afterEach(() => { closeAllParked(); });
describe('Hermes Runs stream recovery', () => {
  it.each([false, true])('resumes after a stream break/early EOF with cursor zero and deduplicates text/tools (broken=%s)', async broken => {
    const first = { event: 'message.delta', delta: 'One ' };
    const tool = { event: 'tool.started', tool: 'terminal', preview: 'Synthetic fixture' };
    const f = fixture([
      () => events([frame(first, 0)], broken),
      () => events([frame(first, 0), frame(tool, 1), frame(tool, 1), frame({ event: 'tool.completed', tool: 'terminal', preview: '{"output":"fixture"}' }, 2), frame({ event: 'message.delta', delta: 'two' }, 3), frame({ event: 'run.completed', output: 'One two', usage: {} }, 4)]),
    ]);
    const result = await run(f.fetcher);
    expect(result.text).toBe('One two');
    expect(result.parts.filter(p => p.type === 'tool-call')).toHaveLength(1);
    expect(result.parts.filter(p => p.type === 'tool-result')).toHaveLength(1);
    expect(f.calls.filter(c => c.path.endsWith('/events')).map(c => c.headers['Last-Event-ID'])).toEqual([undefined, '0']);
    expect(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/runs'))).toHaveLength(1);
  });
  it('falls back to status without reconnect when the failed stream had no sequence ids', async () => {
    const f = fixture([() => events([], true)]);
    expect((await run(f.fetcher)).text).toBe('Status result');
    expect(f.calls.filter(c => c.path.endsWith('/events'))).toHaveLength(1);
  });
  it.each(['missing', 'gap', 'truncated', 'invalid', 'unsafe integer'])('uses status when replay is unsafe (%s)', async fault => {
    const bad = fault === 'truncated' ? frame({ event: 'replay.truncated' }) : fault === 'invalid' ? 'id: opaque\ndata: {"event":"message.delta","delta":"duplicate"}\n\n' : frame({ event: 'message.delta', delta: 'duplicate' }, fault === 'gap' ? 9 : fault === 'unsafe integer' ? Number.MAX_SAFE_INTEGER + 1 : undefined);
    const f = fixture([() => events([frame({ event: 'reasoning.available', text: 'Synthetic' }, 0)], true), () => events([bad])]);
    const result = await run(f.fetcher);
    expect(result.text).toBe('Status result');
    expect(result.text).not.toContain('duplicate');
  });
  it('bounds cursor reconnect attempts before status fallback', async () => {
    const f = fixture([() => events([frame({ event: 'reasoning.available', text: 'Synthetic' }, 0)], true)]);
    expect((await run(f.fetcher)).text).toBe('Status result');
    expect(f.calls.filter(c => c.path.endsWith('/events'))).toHaveLength(3);
  });
  it('keeps one approval after cursor replay and discards its duplicate on explicit continuation', async () => {
    const tool = { event: 'tool.started', tool: 'terminal', preview: 'Synthetic fixture' };
    const approval = { event: 'approval.request', request_id: 'approval-synthetic', command: 'Synthetic fixture', choices: ['once', 'deny'] };
    const f = fixture([() => events([frame(tool, 0)], true), () => events([frame(tool, 0), frame(approval, 1), frame(approval, 1), frame({ event: 'run.completed', output: 'Done', usage: {} }, 2)])]);
    const result = await run(f.fetcher);
    expect(result.parts.filter(p => p.type === 'tool-approval-request')).toHaveLength(1);
    expect(result.parts.filter(p => p.type === 'tool-call')).toHaveLength(1);
    expect(f.calls.some(c => c.path.endsWith('/approval'))).toBe(false);
    const request = result.parts.find(p => p.type === 'tool-approval-request')!;
    const resumed = streamText({ model: model(f.fetcher), messages: [
      { role: 'user', content: 'Synthetic fixture' }, ...result.messages,
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: request.approvalId, approved: false, providerExecuted: true }] },
    ] });
    const parts = []; for await (const part of resumed.fullStream) parts.push(part);
    expect(parts.filter(p => p.type === 'tool-approval-request')).toHaveLength(0);
    expect(f.calls.filter(c => c.path.endsWith('/approval'))).toHaveLength(1);
  });
  it('preserves one durable admission after acceptance loses its reply and gives distinct turns distinct keys', async () => {
    const keys: string[] = []; const admissions = new Map<string, { run_id: string }>(); let lost = true;
    const f = fixture([() => events([frame({ event: 'run.completed', output: 'Done', usage: {} }, 0)]), () => events([frame({ event: 'run.completed', output: 'Done', usage: {} }, 0)])]);
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST' && url.endsWith('/runs')) {
        const key = (init.headers as Record<string, string>)['Idempotency-Key']; keys.push(key);
        if (!admissions.has(key)) {
          // The synthetic server accepts durably before the transport loses its response.
          await f.fetcher(url, init);
          admissions.set(key, { run_id: `run_synthetic_${admissions.size + 1}` });
        }
        if (lost) { lost = false; throw new TypeError('Synthetic lost reply after admission'); }
        return json(admissions.get(key));
      }
      return f.fetcher(url, init);
    }) as typeof fetch;
    const options = { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Synthetic fixture' }] }] };
    await expect(model(fetcher, 'portal-turn-one').doGenerate(options)).rejects.toThrow('reachable');
    expect(admissions.size).toBe(1);
    const originalRun = admissions.get('portal-portal-turn-one')!.run_id;
    expect((await model(fetcher, 'portal-turn-one').doGenerate(options)).content).toContainEqual({ type: 'text', text: 'Done' });
    expect(admissions.size).toBe(1);
    expect(f.calls.filter(c => c.path.endsWith('/events'))[0].path).toContain(originalRun);
    await model(fetcher, 'portal-turn-two').doGenerate(options);
    expect(admissions.size).toBe(2);
    expect(admissions.get('portal-portal-turn-two')!.run_id).not.toBe(originalRun);
    expect(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/runs'))).toHaveLength(2);
    expect(keys).toEqual(['portal-portal-turn-one', 'portal-portal-turn-one', 'portal-portal-turn-two']);
  });
  it('routes Stop to the same remote run during cursor reconnection', async () => {
    const abort = new AbortController(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    const f = fixture([() => events([frame({ event: 'message.delta', delta: 'Partial' }, 0)], true),
      () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }))]);
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/stop')) {
        stream.enqueue(new TextEncoder().encode(frame({ event: 'run.cancelled' }, 1))); stream.close();
      }
      return f.fetcher(url, init);
    }) as typeof fetch;
    const result = run(fetcher, abort.signal);
    await vi.waitFor(() => expect(f.calls.filter(c => c.path.endsWith('/events'))).toHaveLength(2));
    abort.abort(); await expect(result).rejects.toHaveProperty('name', 'AbortError');
    expect(f.calls.filter(c => c.path.endsWith('/stop')).map(c => c.path)).toEqual(['/p/fixture/v1/runs/run_synthetic/stop']);
    expect(f.calls.filter(c => c.method === 'POST' && c.path.endsWith('/runs'))).toHaveLength(1);
  });

  it('keeps status fallback across an approval pause and worker restart without replaying an old approval', async () => {
    let saved: ResumeState | undefined; let answered = false; let streams = 0;
    const fetcher = (async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/runs') && init.method === 'POST') return json({ run_id: 'run_synthetic' });
      if (url.endsWith('/events')) {
        ++streams;
        if (streams === 1) return events([frame({ event: 'tool.started', tool: 'terminal', preview: 'Synthetic' }, 0)], true);
        return events([frame({ event: 'replay.truncated' })]);
      }
      if (url.endsWith('/approval')) { answered = true; return json({ resolved: 1 }); }
      return json(answered ? { status: 'completed', output: 'Done', usage: {} } : {
        status: 'waiting_for_approval', approval: { request_id: 'approval-synthetic', command: 'Synthetic', choices: ['once', 'deny'] },
      });
    }) as typeof fetch;
    const ctx = {
      target: { baseUrl: 'https://hermes.example.com', profile: 'fixture', apiKey: 'synthetic-key', fetch: fetcher },
      sessionId: 'session-synthetic', sessionKey: 'scope-synthetic', interactive: true, approvalTimeoutSec: 1,
    };
    const handle = (resumeState: ResumeState | null) => ({ id: 'portal-turn', segment: resumeState ? 1 : 0, legacy: false, resumeState, saveResumeState(state: ResumeState) { saved = state; } });
    const first = streamText({ model: new HermesLanguageModel('fixture', { ...ctx, run: handle(null) }), prompt: 'Synthetic fixture' });
    const parts = [];
    for await (const part of first.fullStream) parts.push(part);
    const request = parts.find(p => p.type === 'tool-approval-request');
    expect(request).toBeDefined(); expect(saved?.hermes?.statusOnly).toBe(true);
    closeAllParked();
    const resumed = streamText({ model: new HermesLanguageModel('fixture', { ...ctx, run: handle(saved!) }), messages: [
      { role: 'user', content: 'Synthetic fixture' }, ...(await first.response).messages,
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: request!.approvalId, approved: false, providerExecuted: true }] },
    ] });
    const resumedParts = [];
    for await (const part of resumed.fullStream) resumedParts.push(part);
    expect(streams).toBe(2);
    expect(resumedParts.filter(p => p.type === 'tool-approval-request')).toHaveLength(0);
    expect(await resumed.text).toBe('Done');
  });

});
