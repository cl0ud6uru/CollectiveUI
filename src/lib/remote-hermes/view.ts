import { z } from 'zod';
import { record, type RpcRecord, type SocketState } from './socket';

const displayText = (v: unknown, max = 32000) => typeof v === 'string' ? v.slice(0, max) : '';
export type NativePrompt = { id: string; method: string; title: string; command: string; choices: string[]; questions: { id: string; question: string; choices: string[] }[] };
export type NativeSessionView = {
  id: string; title: string; profile: string; running: boolean; uncertain: boolean; connection: SocketState;
  messages: { id: string; role: string; text: string }[]; partial: string;
  tools: { id: string; name: string; detail: string; done: boolean }[];
  prompts: NativePrompt[]; model: string; provider: string; usage: RpcRecord; queued: string; queuePending: boolean;
  yolo?: boolean | null; approvalMode?: string;
  runtimeVersion?: string; desktopContract?: number | null; nativeProfile?: string;
};
export const PROMPT_METHODS = ['approval', 'clarify', 'sudo', 'secret', 'vault.unlock_prompt', 'vault.save_login', 'vault.code'] as const;
export function promptView(id: string | number, method: string, raw: unknown): NativePrompt | null {
  if (!(PROMPT_METHODS as readonly string[]).includes(method)) return null;
  const p = record(raw);
  return { id: String(id), method, title: displayText(p.question || p.description || p.prompt || p.display_name || p.env_var || method, 2000),
    command: displayText(p.command, 4000), choices: Array.isArray(p.choices) ? p.choices.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
    questions: Array.isArray(p.questions) ? p.questions.slice(0, 30).map(q => { const r = record(q); return { id: displayText(r.qid ?? r.id, 100), question: displayText(r.question, 2000), choices: Array.isArray(r.choices) ? r.choices.filter((x): x is string => typeof x === 'string').slice(0, 20) : [] }; }) : [],
  };
}
/** Project display fields only. Native tokens, environment, paths and attachment bytes never enter the snapshot. */
export function sessionView(id: string, profile: string, snapshot: RpcRecord, connection: SocketState): NativeSessionView {
  const info = record(snapshot.info), inflight = record(snapshot.inflight);
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages.slice(-200).map((m, i) => {
    const row = record(m); return { id: String(row.row_id ?? i), role: displayText(row.role, 30), text: displayText(row.text) };
  }) : [];
  const partial = displayText(inflight.assistant, 128000);
  const turnStart = typeof snapshot.turn_started_at === 'number' ? snapshot.turn_started_at : 0;
  const prompt = displayText(inflight.user);
  if (prompt) {
    const native = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const lastUser = [...native].reverse().find(m => record(m).role === 'user');
    if (!lastUser || displayText(record(lastUser).text) !== prompt || (turnStart > 0 && Number(record(lastUser).timestamp ?? 0) < turnStart - 1))
      messages.push({ id: 'inflight-user', role: 'user', text: prompt });
  }
  // A flushed assistant prefix in history is represented by the in-flight row until it settles.
  if (partial && messages.at(-1)?.role === 'assistant' && partial.startsWith(messages.at(-1)!.text)) messages.pop();
  const usage = record(info.usage);
  const counts: RpcRecord = {};
  for (const key of ['input', 'output', 'reasoning', 'cached', 'context_used', 'context_max', 'context_percent', 'cache_read', 'cache_write', 'cost_usd'])
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) counts[key] = usage[key];
  return { id, title: displayText(info.title, 500) || 'Hermes chat', profile, running: snapshot.running === true || info.running === true || !!displayText(record(snapshot.queued).user, 4000),
    uncertain: false, connection, messages, partial, tools: [], prompts: [], model: displayText(info.model, 200), provider: displayText(info.provider, 200), usage: counts,
    queued: displayText(record(snapshot.queued).user, 4000), queuePending: false,
    yolo: typeof info.yolo === 'boolean' ? info.yolo : null,
    approvalMode: ['manual', 'smart', 'off'].includes(String(info.approval_mode)) ? String(info.approval_mode) : '',
    runtimeVersion: displayText(info.version, 100), desktopContract: Number.isSafeInteger(info.desktop_contract) ? Number(info.desktop_contract) : null,
    nativeProfile: displayText(info.profile_name, 200),
  };
}
export function answerFor(prompt: NativePrompt, input: unknown): RpcRecord {
  if (prompt.method === 'approval') return z.object({ choice: z.enum(['once', 'deny']) }).strict().parse(input);
  if (prompt.method === 'clarify') {
    if (prompt.questions.length) {
      const result = z.object({ answers: z.record(z.string().max(100), z.string().max(4000)) }).strict().parse(input);
      if (Object.keys(result.answers).some(id => !prompt.questions.some(q => q.id === id))) throw new Error('Invalid native question identity.');
      return result;
    }
    return z.object({ answer: z.string().max(8000) }).strict().parse(input);
  }
  return z.object({ value: z.string().max(16000) }).strict().parse(input);
}
