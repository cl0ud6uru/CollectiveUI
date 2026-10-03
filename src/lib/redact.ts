/**
 * Masks things that look like credentials before text reaches logs, error messages, the browser or stored
 * tool output. Pattern-based, so it is a safety net, not a guarantee: never pass secrets around on purpose.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, // PEM keys (service accounts)
  /\bsk-ant-(?:api|oat|ort|sid|admin)\d*-[A-Za-z0-9_-]{10,}/g, // Anthropic keys, OAuth tokens and session keys
  /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /\bat-[A-Za-z0-9_-]{20,}/g, // Codex personal access tokens
  /\brt_[A-Za-z0-9._-]{20,}/g, // OAuth refresh tokens (ChatGPT sign-in)
  /\bptl_[A-Za-z0-9_-]{16,}/g, // portal-issued tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key ids
  /\bABSK[A-Za-z0-9+/=]{20,}/g, // Bedrock API keys
  /\bbedrock-api-key-[A-Za-z0-9+/=%]{20,}/g, // Bedrock short-term API keys
  /\bya29\.[A-Za-z0-9._-]{20,}/g, // Google OAuth access tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
];

export function redactSecrets(text: string): string {
  let out = text.replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  for (const re of PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
