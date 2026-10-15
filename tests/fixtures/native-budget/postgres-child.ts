import { nativeBudgetFixtureURL } from './disposable-database';
// No database-backed imports, pools or connection defaults are evaluated before this guard.
process.env.DATABASE_URL = nativeBudgetFixtureURL();
process.env.DATABASE_POOL_MAX = '1';
globalThis.fetch = async () => { throw new Error('The PostgreSQL reservation child forbids all provider/network requests'); };
type Request = { id: number; action: 'reserve' | 'dispatch' | 'retain' | 'settle' | 'release' | 'crash'; root: string; owner: string; receiptId?: string; input?: number | null; output?: number | null };
async function main() {
  const { pool } = await import('../../../src/db');
  const api = await import('../../../src/lib/llm/run-budget-store');
  const { rows } = await pool.query('select pg_backend_pid() as backend');
  process.send!({ type: 'ready', pid: process.pid, backend: rows[0].backend });
  let chain = Promise.resolve();
  process.on('message', (request: Request) => {
    chain = chain.then(async () => {
      if (request.action === 'crash') process.exit(17);
      try {
        const ctx = { purpose: 'delegate' as const, billingSource: 'org' as const, providerKind: 'openai-compatible' as const, model: 'fixture-budget', appId: null,
          userId: request.owner, billingRoute: 'api:openai-compatible', scope: { pending: [], messageId: `child-${process.pid}`, runId: `child-${process.pid}`, rootBudgetId: request.root } };
        const handle = await api.nativeBudgetHandle(ctx);
        if (!handle) { process.send!({ type: 'result', id: request.id, disabled: true }); return; }
        const receipt = { id: request.receiptId!, handle };
        if (request.action === 'reserve') {
          const admitted = await api.reserveNativeBudget(handle, ctx, { prompt: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic race' }] }] }, 64);
          process.send!({ type: 'result', id: request.id, receiptId: admitted.id }); return;
        }
        if (request.action === 'dispatch') await api.markNativeBudgetDispatched(receipt);
        else if (request.action === 'retain') await api.retainNativeBudget(receipt);
        else if (request.action === 'settle') await api.settleNativeBudget(receipt, request.input, request.output);
        else if (request.action === 'release') await api.releaseNativeBudget(receipt);
        else throw new Error('Unsupported synthetic child command');
        process.send!({ type: 'result', id: request.id, ok: true });
      } catch (error) {
        process.send!({ type: 'result', id: request.id, error: error instanceof Error ? error.name : 'UnknownError' });
      }
    }).catch(() => { process.exitCode = 1; process.disconnect(); });
  });
  process.on('disconnect', () => { void pool.end().then(() => process.exit()); });
}
main().catch(() => { console.error('Synthetic PostgreSQL child setup failed'); process.exit(1); });
