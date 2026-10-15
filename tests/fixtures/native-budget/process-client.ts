import { fork } from 'node:child_process';
import path from 'node:path';
type Result = { receiptId?: string; error?: string; ok?: boolean; disabled?: boolean };
type Request = { action: 'reserve' | 'dispatch' | 'retain' | 'settle' | 'release' | 'crash'; root: string; owner: string; receiptId?: string; input?: number | null; output?: number | null };
export async function budgetChild(url: string, policy: string) {
  const child = fork(path.resolve('tests/fixtures/native-budget/postgres-child.ts'), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, NATIVE_BUDGET_POSTGRES_PROOF: '1', NATIVE_BUDGET_POSTGRES_TEST_URL: url, NATIVE_RUN_BUDGET: policy, NODE_ENV: 'test' } });
  let next = 0; let diagnostics = '';
  child.stderr!.on('data', part => { diagnostics = (diagnostics + String(part)).slice(-4000); });
  const pending = new Map<number, { resolve: (value: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve!: (value: { pid: number; backend: number }) => void; let readyReject!: (error: Error) => void;
  const ready = new Promise<{ pid: number; backend: number }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timer = setTimeout(() => { readyReject(new Error('Synthetic child readiness timed out')); child.kill(); }, 20000);
  child.on('message', (message: Result & { type: string; id: number; pid: number; backend: number }) => {
    if (message.type === 'ready') { clearTimeout(timer); readyResolve(message); return; }
    const waiting = pending.get(message.id); if (!waiting) return;
    clearTimeout(waiting.timer); pending.delete(message.id); waiting.resolve(message);
  });
  child.on('exit', (code, signal) => {
    clearTimeout(timer); const error = new Error(`Synthetic child exited (${code ?? signal}): ${diagnostics}`);
    readyReject(error); for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); } pending.clear();
  });
  child.on('error', readyReject);
  const identity = await ready;
  return { ...identity,
    command(request: Request): Promise<Result> {
      return new Promise((resolve, reject) => { const id = ++next;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Synthetic child command timed out')); child.kill(); }, 20000);
        pending.set(id, { resolve, reject, timer: timeout }); child.send({ ...request, id }, error => { if (error) { clearTimeout(timeout); pending.delete(id); reject(error); } });
      });
    },
    async close() { if (child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.disconnect(); const force = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(force); },
  };
}
