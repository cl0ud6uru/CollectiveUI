import { z } from 'zod';

const text = (v: unknown, limit = 2000) => typeof v === 'string' ? v.slice(0, limit) : '';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export type NativeQuestion = { id: string; question: string; choices: string[] };
export type ManagedPrompt = { id: string; method: string; title: string; command: string; single?: boolean; choices?: string[]; questions: NativeQuestion[] };
export const INPUT_METHODS = ['clarify', 'sudo', 'secret', 'vault.unlock_prompt', 'vault.save_login', 'vault.code'] as const;
/** Closed display projection: prompt values, environment and native identifiers never leave the controller. */
export function managedPrompt(id: string, method: string, params: Record<string, unknown>): ManagedPrompt | null {
  if (!(INPUT_METHODS as readonly string[]).includes(method)) return null;
  return { id, method, choices: Array.isArray(params.choices) ? params.choices.filter((s): s is string => typeof s === 'string').slice(0, 20).map(s => text(s)) : [], single: method === 'clarify' && !Array.isArray(params.questions), title: text(params.question || params.description || params.prompt || params.display_name || params.site || params.env_var || method), command: text(params.command, 4000),
    questions: Array.isArray(params.questions) ? params.questions.slice(0, 30).map(raw => { const q = object(raw); return { id: text(q.qid, 100), question: text(q.question), choices: Array.isArray(q.choices) ? q.choices.filter((s): s is string => typeof s === 'string').slice(0, 20).map(s => text(s)) : [] }; }) : [],
  };
}
export function managedAnswer(prompt: ManagedPrompt, input: unknown): Record<string, unknown> {
  if (prompt.method === 'clarify') {
    if (prompt.single) return z.object({ answer: z.string().max(4000) }).strict().parse(input);
    const result = z.object({ answers: z.record(z.string().min(1).max(100), z.string().max(4000)) }).strict().parse(input);
    if (Object.keys(result.answers).some(id => !prompt.questions.some(q => q.id === id))) throw new Error('Invalid question identity');
    return result;
  }
  return z.object({ value: z.string().max(16000) }).strict().parse(input);
}
export const nativeAttachment = z.object({ name: z.string().min(1).max(200).regex(/^[^\\/\x00-\x1f\x7f]+$/).refine(v => v !== '.' && v !== '..'),
  mediaType: z.string().min(1).max(100).regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/),
  contentBase64: z.string().min(1).max(12 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export type NativeAttachment = z.infer<typeof nativeAttachment>;
export const nativeAttachments = z.array(nativeAttachment).max(8).superRefine((files, ctx) => {
  let total = 0;
  for (const file of files) { const bytes = Buffer.from(file.contentBase64, 'base64').length; total += bytes; if (bytes > 8 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'A native attachment exceeds 8 MB.' }); }
  if (total > 16 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Native attachments exceed 16 MB in total.' });
});
export const managedControl = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('answer'), requestId: z.string().regex(/^[a-f0-9]{32}$/), answer: z.unknown() }).strict(),
  z.object({ operation: z.enum(['steer', 'queue']), requestId: z.string().uuid(), text: z.string().trim().min(1).max(4000) }).strict(),
]);
export type ManagedRunView = { running: boolean; status: string; model: string; provider: string; usage: Record<string, number>; prompts: ManagedPrompt[]; queued: string; features: string[] };

export const skipManagedPrompt = (prompt: ManagedPrompt): Record<string, unknown> => prompt.method === 'clarify' ? prompt.single ? { answer: '' } : { answers: {} } : { value: '' };
