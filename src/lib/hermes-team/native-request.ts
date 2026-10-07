import { z } from 'zod';
import { HttpError } from '@/lib/authz';
import { canonicalTeamToolInput } from './tool-policy';

export type TeamNativeModelProtocol = 'chat_completions' | 'responses';
export const CANDIDATE_MODEL_LIMITS = Object.freeze({ requests: 8, inputBytes:512000,outputTokens: 2048, perRequestOutput: 256, requestBytes: 64000, responseBytes: 2_000_000 });
const fields = {
  chat_completions: new Set(['model','messages','tools','tool_choice','stream','stream_options','temperature','top_p','max_tokens','max_completion_tokens','parallel_tool_calls','reasoning_effort','reasoning','response_format','stop','n','presence_penalty','frequency_penalty','seed']),
  responses: new Set(['model','input','instructions','tools','tool_choice','stream','temperature','top_p','max_output_tokens','parallel_tool_calls','reasoning','text','include','truncation','store']),
};

/** Supported pinned native OpenAI transports only. Requesters cannot choose routing, identity or provider headers. */
export function validateNativeModelRequest(raw: unknown, protocol: TeamNativeModelProtocol, model: string): Record<string, unknown> {
  const body = z.record(z.string(), z.unknown()).parse(raw);
  canonicalTeamToolInput(body);
  if (Object.keys(body).some(key => !fields[protocol].has(key))) throw new HttpError(400, 'Unsupported native model request field.');
  if (body.model !== model || (body.stream !== undefined && typeof body.stream !== 'boolean')) throw new HttpError(409, 'The native model does not match the fixed Team route.');
  if (protocol === 'chat_completions' && (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256)) throw new HttpError(400, 'Invalid native message request.');
  if (protocol === 'responses' && !(typeof body.input === 'string' || Array.isArray(body.input))) throw new HttpError(400, 'Invalid native Responses input.');
  if (body.n !== undefined && body.n !== 1) throw new HttpError(400, 'Multiple model candidates are unsupported.');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined)
    throw new HttpError(409, 'Choose one fixed native output limit.');
  if(body.reasoning!==undefined){
    if(protocol==='chat_completions')z.object({enabled:z.literal(false)}).strict().parse(body.reasoning);
    else z.object({effort:z.enum(['minimal','low','medium','high']).optional(),summary:z.enum(['auto','concise','detailed']).optional()}).strict().parse(body.reasoning);
  }
  if (body.stream_options !== undefined) z.object({include_usage:z.boolean().optional()}).strict().parse(body.stream_options);
  if(body.tools!==undefined && (!Array.isArray(body.tools) || body.tools.some(tool=>!tool || typeof tool!=='object' || tool.type!=='function')))
    throw new HttpError(409,'Hosted provider tools are unsupported by the bounded native adapter.');
  const textContent=(content:unknown)=>content===null || typeof content==='string' || (Array.isArray(content) && content.every(part=>part && typeof part==='object'
    && ['text','input_text','output_text'].includes(part.type) && typeof part.text==='string'));
  if(protocol==='chat_completions' && (body.messages as Record<string,unknown>[]).some(message=>!message || typeof message!=='object' || !textContent(message.content)))
    throw new HttpError(409,'Only text native model content is supported by this adapter.');
  if(protocol==='responses' && Array.isArray(body.input) && body.input.some(item=>!item || typeof item!=='object' || (item.content!==undefined && !textContent(item.content))
    || (item.type && !['message','function_call','function_call_output','reasoning'].includes(item.type))))throw new HttpError(409,'Unsupported native Responses item.');
  const outputKey = protocol === 'responses' ? 'max_output_tokens' : body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens';
  const requested = body[outputKey];
  if (requested !== undefined && (!Number.isSafeInteger(requested) || (requested as number) < 1 || (requested as number) > CANDIDATE_MODEL_LIMITS.perRequestOutput))
    throw new HttpError(409, 'This request exceeds the bounded Team model allowance.');
  const supported={...body};
  // The pinned auxiliary title task emits this exact disable hint through extra_body.
  // It is an internal native setting, not a public Chat Completions parameter.
  if(protocol==='chat_completions')delete supported.reasoning;
  return { ...supported, [outputKey]: requested ?? CANDIDATE_MODEL_LIMITS.perRequestOutput,
    ...(protocol === 'chat_completions' && body.stream === true ? {stream_options:{include_usage:true}} : {}),
    ...(protocol === 'responses' ? { store: false } : {}) };
}

export async function readCandidateJson(request: Request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required.');
  if (!request.body) throw new HttpError(400, 'A request body is required.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>{reject(new HttpError(408,'Native request body timed out.'));void reader.cancel().catch(()=>{});},8000);});
  const aborted=()=>{void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',aborted,{once:true});
  try {
    for (;;) {
      if(request.signal.aborted)throw new HttpError(408,'Native request was aborted.');
      const { done, value } = await Promise.race([reader.read(),deadline]); if (done) break;
      bytes += value.length; if (bytes > CANDIDATE_MODEL_LIMITS.requestBytes) { await reader.cancel(); throw new HttpError(413, 'The native request exceeds its supported bound.'); }
      chunks.push(value);
    }
  } finally { clearTimeout(timeout);request.signal.removeEventListener('abort',aborted);reader.releaseLock(); }
  if(request.signal.aborted)throw new HttpError(408,'Native request was aborted.');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new HttpError(400, 'Invalid native JSON.'); }
}
