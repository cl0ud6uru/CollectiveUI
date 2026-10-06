import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { McpServer } from "@/db/schema";
import { AAD, decryptOptional } from "@/lib/crypto";
import { redactSecrets } from "@/lib/redact";
import { identityClaims, openIdentitySecret, signIdentity, type IdentitySubject, type ServiceIdentity } from "./identity";
import { checkMcpUrl } from "./url";

export type McpCaller = { subject: IdentitySubject; botId?: string | null; conversationId?: string | null; service?: ServiceIdentity;
  /** Native Team adapters must reauthorize every transport request, including initialize and continuation. */
  authorize?: () => Promise<McpCaller> };

export const MCP_CLIENT_NAME = "ai-portal";

/** The server's static headers (e.g. its bearer key), decrypted. */
export function staticHeaders(server: Pick<McpServer, "headersEnc">): Record<string, string> {
  return server.headersEnc ? (JSON.parse(decryptOptional(server.headersEnc, AAD.mcpHeaders) ?? "{}") as Record<string, string>) : {};
}

/**
 * Every request the transport makes goes through here: only to the server's own origin, never following a
 * redirect (the bearer key and identity token must not be replayed elsewhere), with a freshly minted identity
 * token when the server has identity turned on.
 */
export function mcpFetch(server: Pick<McpServer, "id" | "url" | "identityHeader" | "identitySecretEnc">, caller: McpCaller): typeof fetch {
  const origin = new URL(server.url).origin;
  const secret = server.identityHeader ? openIdentitySecret(server) : null;
  return async (input, init) => {
    const current = caller.authorize ? await caller.authorize() : caller;
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (target.origin !== origin) throw new Error(`Refusing to send an MCP request to ${target.origin}: it isn't the server's origin`);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    if (secret && server.identityHeader) {
      const claims = identityClaims(current.subject, { audience: server.url, botId: current.botId, conversationId: current.conversationId, service: current.service });
      headers.set(server.identityHeader, signIdentity(claims, secret));
    }
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}

/** Successful responses can echo secrets too. Sanitize before any result enters model/UI/persistence paths. */
export function redactMcpValue<T>(value: T, server: Pick<McpServer, "id" | "headersEnc" | "identitySecretEnc">): T {
  const secrets = [...Object.values(staticHeaders(server)).flatMap((v) => [v, v.replace(/^(Bearer|Basic)\s+/i, "")]), ...(server.identitySecretEnc ? [openIdentitySecret(server)!] : [])].filter(Boolean);
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") {
      for (const secret of secrets) v = (v as string).split(secret).join("[redacted]");
      return redactSecrets(v as string);
    }
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [clean(k), clean(val)]));
    return v;
  };
  return clean(value) as T;
}

/** Opens a connection (initialize handshake included) to an MCP server as the given caller. */
export async function connectMcp(server: McpServer, caller: McpCaller): Promise<MCPClient> {
  const problem = await checkMcpUrl(server.url);
  if (problem) throw new Error(problem);
  return createMCPClient({
    transport: { type: server.transport, url: server.url, headers: staticHeaders(server), redirect: "error", fetch: mcpFetch(server, caller) },
    clientName: MCP_CLIENT_NAME,
    initializationOptions: { timeout: server.timeoutMs },
  });
}

/** A connection or call failure, safe to show to people and store (no keys, no tokens). */
export function mcpErrorMessage(err: unknown, server?: Pick<McpServer, "id" | "headersEnc" | "identitySecretEnc">): string {
  const message = err instanceof Error ? err.message : String(err);
  return (server ? redactMcpValue(message, server) : redactSecrets(message)).slice(0, 500);
}
