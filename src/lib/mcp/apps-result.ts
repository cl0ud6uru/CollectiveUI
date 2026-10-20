import { capResult, stripHidden, type McpCallResult } from './hygiene';

export const MAX_APP_HTML_BYTES = 1024 * 1024;
export const MAX_APP_META_BYTES = 64 * 1024;

/** Native Apps keep structured data alongside narration. Both count against the existing server budget. */
export function appModelResult(result: McpCallResult, budget: number): McpCallResult {
  budget = Math.min(budget, 256 * 1024);
  const capped = capResult(result, budget);
  if (result.structuredContent !== undefined && capped.structuredContent === undefined) {
    const structuredContent = JSON.parse(stripHidden(JSON.stringify(result.structuredContent)));
    if (Buffer.byteLength(JSON.stringify({ ...capped, structuredContent })) <= budget) capped.structuredContent = structuredContent;
  }
  return capped;
}

/** Component-only metadata has a separate hard budget. It is never returned in the tool's model/UI output. */
export function appComponentResult(result: McpCallResult, budget: number) {
  const model = appModelResult(result, budget);
  const value = result._meta;
  if (value && typeof value === 'object' && !Array.isArray(value) && Buffer.byteLength(JSON.stringify(value)) <= MAX_APP_META_BYTES)
    return { ...model, _meta: value as Record<string, unknown> };
  return model;
}

/** Only the exact accepted URI, a single HTML payload, and supported MIME types are accepted. */
export function appHtmlResource(raw: unknown, uri: string, compatibility: boolean): string {
  const content = (raw as { contents?: unknown[] } | null)?.contents;
  if (!Array.isArray(content) || content.length !== 1) throw new Error('The widget resource must contain one HTML document.');
  const part = content[0] as { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown } | null;
  if (!part || part.uri !== uri || (part.mimeType !== 'text/html;profile=mcp-app' && !(compatibility && part.mimeType === 'text/html+skybridge')))
    throw new Error('Unsupported widget resource URI or MIME type.');
  let html: string;
  if (typeof part.text === 'string') html = part.text;
  else if (typeof part.blob === 'string' && part.blob.length <= Math.ceil(MAX_APP_HTML_BYTES / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(part.blob))
    html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(part.blob, 'base64'));
  else throw new Error('The widget resource has no supported HTML payload.');
  if (Buffer.byteLength(html) > MAX_APP_HTML_BYTES) throw new Error('The widget resource exceeds 1 MiB.');
  return html;
}
