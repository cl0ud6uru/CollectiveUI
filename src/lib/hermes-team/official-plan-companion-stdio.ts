import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { OfficialPlanCompanionReceiver } from './official-plan-companion-receiver';
import { OfficialPlanLocalCompanion, LocalPairingSchema } from './official-plan-local-companion';
import { CompanionPrivateStore } from './official-plan-companion-storage';
import { companionFailure } from './official-plan-companion-protocol';

const frameSchema = z.object({ id: z.string().uuid(), action: z.enum(['challenge', 'receive', 'recover']), input: z.unknown() }).strict();
async function* frames(input: Readable) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]); if (pending.length > 128000) throw companionFailure();
    for (;;) { const end = pending.indexOf(10); if (end < 0) break; const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      yield JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
  }
  if (pending.length) throw companionFailure();
}
function write(output: Writable, value: unknown) { return new Promise<void>((resolve, reject) => output.write(`${JSON.stringify(value)}\n`, error => error ? reject(companionFailure()) : resolve())); }
/** This service gets its Principal from the receiver's independent, approved gateway context on every request. */
export async function runOfficialPlanReceiver(input: Readable, output: Writable, receiver: OfficialPlanCompanionReceiver) {
  try { for await (const raw of frames(input)) {
    const frame = frameSchema.parse(raw);
    try { const result = await receiver[frame.action](frame.input); await write(output, { id: frame.id, ok: true, result }); }
    catch { await write(output, { id: frame.id, ok: false, error: 'Protected transfer was not confirmed.' }); }
  } } catch { await write(output, { ok: false, error: 'Protected transfer was not confirmed.' }); }
}
export class CompanionRpcClient {
  private readonly iterator: AsyncGenerator<unknown>;
  private busy = false;
  private failed = false;
  constructor(input: Readable, private readonly output: Writable) { this.iterator = frames(input); }
  async request(action: 'challenge' | 'receive' | 'recover', input: unknown) {
    if (this.busy || this.failed) throw companionFailure(); this.busy = true;
    const id = randomUUID(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(companionFailure()), 30000); });
      await Promise.race([write(this.output, { id, action, input }), deadline]);
      const frame = await Promise.race([this.iterator.next(), deadline]);
      const reply = z.object({ id: z.string().uuid(), ok: z.boolean(), result: z.unknown().optional(), error: z.string().optional() }).strict().parse(frame.value);
      if (frame.done || reply.id !== id || !reply.ok) throw companionFailure(); return reply.result;
    } catch { this.failed = true; throw companionFailure(); } finally { clearTimeout(timer); this.busy = false; }
  }
}
/** Uses only an already-approved SSH destination and existing credentials/known-hosts. Never installs keys or logs stderr. */
export function openApprovedCompanionSsh(destination: string) {
  if (!/^(?:[a-zA-Z0-9_.]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}$/.test(destination)) throw companionFailure();
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', destination, 'collectiveui-official-plan-receiver'], { shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  child.on('error', () => { child.stdout.destroy(companionFailure()); });
  child.stdin.on('error', () => { child.stdout.destroy(companionFailure()); });
  return { client: new CompanionRpcClient(child.stdout, child.stdin), close: () => { child.stdin.end(); child.kill(); } };
}
export type ApprovedLocalCompanionDriver = { id: string; local(): Promise<OfficialPlanLocalCompanion>; openBrowser(url: string): Promise<void>;
  connect(): Promise<{ client: CompanionRpcClient; close(): void }> };
export const VERIFIED_OFFICIAL_LOCAL_DRIVERS: readonly ApprovedLocalCompanionDriver[] = Object.freeze([]);
/** Concrete Linux installation driver. It reads pre-approved private material; it never creates keys, host IDs or SSH configuration. */
export function createApprovedLocalCompanionDriver(directory: string, sshDestination: string): ApprovedLocalCompanionDriver {
  return { id: 'collective-local-siwc-v1',
    local: async () => { const store = new CompanionPrivateStore(directory); return new OfficialPlanLocalCompanion(store, LocalPairingSchema.parse(await store.read('pairing.json'))); },
    connect: async () => openApprovedCompanionSsh(sshDestination),
    openBrowser: async value => {
      const url = new URL(value);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash || ['access_token', 'refresh_token', 'id_token', 'id_token_hint', 'code_verifier'].some(name => url.searchParams.has(name))) throw companionFailure();
      await new Promise<void>((resolve, reject) => {
        const child = spawn('xdg-open', [url.href], { shell: false, stdio: 'ignore' }); child.once('error', () => reject(companionFailure())); child.once('spawn', resolve);
      });
    } };
}
export async function runOfficialPlanLocalCommand(action: string, drivers = VERIFIED_OFFICIAL_LOCAL_DRIVERS) {
  const driver = drivers[0]; if (!driver) throw companionFailure();
  const local = await driver.local();
  if (action === 'status') return local.status();
  if (action === 'sign-in' || action === 'reconnect') return local.signIn(url => driver.openBrowser(url), action === 'reconnect');
  if (action === 'refresh') return local.refresh();
  if (!['transfer', 'recover'].includes(action)) throw companionFailure();
  const transport = await driver.connect();
  try {
    let reply = action === 'transfer' ? await transport.client.request('receive', await local.suspend(await transport.client.request('challenge', await local.offer())))
      : await transport.client.request('recover', await local.recoveryRequest());
    if (action === 'recover' && (reply as { body?: { state?: string } })?.body?.state === 'pending') reply = await transport.client.request('receive', await local.retrySuspended(reply));
    return await local.acknowledge(reply);
  } finally { transport.close(); }
}
