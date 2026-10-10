import { z } from "zod";
import { assertSecurityOrigin, SECURITY_ERROR, SecurityError } from "./factors";
import { allowSecurityRequest } from "./throttle";
import { LdapUnavailableError, logLdapUnavailable } from "./ldap";
const input = z.object({
  action: z.string().max(40), username: z.string().max(254).default(""), password: z.string().max(512).default(""),
  flow: z.string().max(100).default(""), code: z.string().max(80).default(""), recovery: z.boolean().default(false),
  proof: z.string().max(100).default(""), op: z.string().max(40).default(""), value: z.string().max(512).default(""),
  response: z.unknown().optional(),
}).strict();
export async function securityRequest(request: Request) {
  assertSecurityOrigin(request.headers);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json" || !request.body || !await allowSecurityRequest(request.headers)) throw new SecurityError();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.length;
    if (size > 32768) { await reader.cancel(); throw new SecurityError(); }
    chunks.push(next.value);
  }
  return input.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}
export function securityResponse(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } });
}
export function securityFailure() { return securityResponse({ error: SECURITY_ERROR }, 400); }
/** Fixed public error; only a sanitized operation/code is logged for the operator. */
export function directoryUnavailable(err: LdapUnavailableError) {
  logLdapUnavailable(err);
  return securityResponse({ error: SECURITY_ERROR, code: "directory_unavailable" }, 503);
}
