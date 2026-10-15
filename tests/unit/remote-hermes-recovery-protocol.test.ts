import { describe, expect, it, vi } from 'vitest';
import { NativeRpcError } from '@/lib/remote-hermes/socket';
import { readNativeDrain, requestNativeDrain } from '@/lib/remote-hermes/recovery-protocol';
const binding = { recovery_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session_id: 'runtime', stored_session_id: 'stored', reservation_ids: ['queue', 'prompt'], profile: 'default' };
const capability = { protocol: 'collective.cancel-drain.v1', scope: 'inline_prompt_runtime', durable: true };
const receipt = { protocol: capability.protocol, recovery_id: binding.recovery_id, session_id: 'runtime', stored_session_id: 'stored', reservation_ids: ['prompt', 'queue'], state: 'drained', reason: 'drained' };
describe('explicit native cancel-and-drain adapter contract', () => {
  it('accepts only advertised exact-version terminal evidence with every binding intact', async () => {
    const call = vi.fn().mockResolvedValueOnce(capability).mockResolvedValueOnce(receipt);
    expect(await requestNativeDrain({ call }, binding)).toEqual(receipt);
    expect(call.mock.calls.map(args => args[0])).toEqual(['collective.recovery.capabilities', 'collective.recovery.cancel_and_drain']);
    expect(call.mock.calls[1][1]).toEqual(binding);
  });
  it('returns process-changed uncertainty without converting it to completion', async () => {
    const pending = { ...receipt, state: 'pending', reason: 'process_changed' };
    const call = vi.fn().mockResolvedValueOnce(capability).mockResolvedValueOnce(pending);
    expect(await readNativeDrain({ call }, binding)).toEqual(pending);
    expect(call.mock.calls[1]).toEqual(['collective.recovery.status', { recovery_id: binding.recovery_id }]);
  });
  it('does not infer capability from native interrupt, close or an idle snapshot', async () => {
    const call = vi.fn().mockRejectedValue(new NativeRpcError(-32601));
    await expect(requestNativeDrain({ call }, binding)).rejects.toMatchObject({ status: 501 });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...capability, protocol: 'v2' }, { ...capability, durable: false }, { ...capability, scope: 'all_resources' }])('rejects unsupported capability %j', async unsupported => {
    const call = vi.fn().mockResolvedValue(unsupported);
    await expect(requestNativeDrain({ call }, binding)).rejects.toMatchObject({ status: 501 });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it.each([{ session_id: 'other-runtime' }, { stored_session_id: 'other-stored' }, { reservation_ids: ['prompt'] }, { reservation_ids: ['prompt', 'queue', 'unrelated'] }, { state: 'drained', reason: 'workers_pending' }])('rejects mismatched or incomplete evidence %j', async changed => {
    const call = vi.fn().mockResolvedValueOnce(capability).mockResolvedValueOnce({ ...receipt, ...changed });
    await expect(readNativeDrain({ call }, binding)).rejects.toMatchObject({ status: 502 });
  });
  it('refuses duplicate reservation identities before any native call', async () => {
    const call = vi.fn();
    await expect(requestNativeDrain({ call }, { ...binding, reservation_ids: ['same', 'same'] })).rejects.toMatchObject({ status: 400 });
    expect(call).not.toHaveBeenCalled();
  });
});
