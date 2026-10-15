import { z } from 'zod';
import { HttpError } from '@/lib/http-error';
import { NativeRpcError, type DashboardSocket } from './socket';

const protocol = 'collective.cancel-drain.v1' as const;
const capability = z.object({ protocol: z.literal(protocol), scope: z.literal('inline_prompt_runtime'), durable: z.literal(true) }).strict();
const bindingSchema = z.object({
  recovery_id: z.string().uuid(), session_id: z.string().min(1).max(200),
  stored_session_id: z.string().min(1).max(200), reservation_ids: z.array(z.string().min(1).max(200)).min(1).max(100),
  profile: z.string().min(1).max(100),
}).strict();
const receiptSchema = bindingSchema.omit({ profile: true }).extend({
  protocol: z.literal(protocol), state: z.enum(['pending', 'drained']),
  reason: z.enum(['workers_pending', 'process_changed', 'drained']),
}).strict();
export type NativeDrainBinding = z.infer<typeof bindingSchema>;
export type NativeDrainReceipt = z.infer<typeof receiptSchema>;
type Rpc = Pick<DashboardSocket, 'call'>;

/** Explicit optional adapter only. This does not clear local reservations or enable recovery UI. */
export async function requestNativeDrain(socket: Rpc, input: NativeDrainBinding): Promise<NativeDrainReceipt> {
  const binding = validateBinding(input);
  await requireCapability(socket);
  return validateReceipt(await socket.call('collective.recovery.cancel_and_drain', binding), binding);
}
export async function readNativeDrain(socket: Rpc, input: NativeDrainBinding): Promise<NativeDrainReceipt> {
  const binding = validateBinding(input);
  await requireCapability(socket);
  return validateReceipt(await socket.call('collective.recovery.status', { recovery_id: binding.recovery_id }), binding);
}
async function requireCapability(socket: Rpc) {
  try {
    if (capability.safeParse(await socket.call('collective.recovery.capabilities')).success) return;
  } catch (error) {
    if (!(error instanceof NativeRpcError) || error.code !== -32601) throw error;
  }
  throw new HttpError(501, 'This native runtime does not provide verified cancel-and-drain evidence.');
}
function validateBinding(input: NativeDrainBinding) {
  const binding = bindingSchema.parse(input);
  if (new Set(binding.reservation_ids).size !== binding.reservation_ids.length) throw new HttpError(400, 'Recovery reservation identities must be unique.');
  return binding;
}
function validateReceipt(raw: unknown, binding: NativeDrainBinding): NativeDrainReceipt {
  const parsed = receiptSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(502, 'Native recovery returned invalid evidence.');
  const receipt = parsed.data;
  if (receipt.recovery_id !== binding.recovery_id || receipt.session_id !== binding.session_id || receipt.stored_session_id !== binding.stored_session_id ||
      JSON.stringify([...receipt.reservation_ids].sort()) !== JSON.stringify([...binding.reservation_ids].sort()) ||
      ((receipt.state === 'drained') !== (receipt.reason === 'drained'))) throw new HttpError(502, 'Native recovery evidence does not match this reservation.');
  return receipt;
}
