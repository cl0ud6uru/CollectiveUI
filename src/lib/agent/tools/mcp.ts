import type { MCPClient } from "@ai-sdk/mcp";
import { dynamicTool, jsonSchema, type JSONSchema7 } from "ai";
import type { BotToolConfig, McpServer } from "@/db/schema";
import { connectMcp, mcpErrorMessage, redactMcpValue, type McpCaller } from "@/lib/mcp/client";
import { authorizeMcpInvocation, checkedServiceGrant, type ServiceGrant } from "@/lib/mcp/authorization";
import { assertArgumentConstraints } from "@/lib/bots/service-policy";
import { mcpInputValidator } from "@/lib/mcp/input";
import { audit } from "@/lib/audit";
import { sha256Hex } from "@/lib/crypto";
import { canonicalJson, toolHash } from "@/lib/mcp/snapshot";
import { capResult, cleanDescription, mcpResultToModelOutput, stripHidden, type McpCallResult } from "@/lib/mcp/hygiene";
import type { McpToolDef } from "@/lib/mcp/kinds";
import { offeredTools } from "@/lib/mcp/servers";
import { listAllTools } from "@/lib/mcp/snapshot";
import { slugify } from "@/lib/utils";
import type { AgentCtx, ToolEntry } from "../types";

const TOOL_NAME_MAX = 64;

/** "<server slug>__<tool>", limited to what model APIs accept (letters, digits, _ and -; 64 chars), unique per turn. */
export function modelToolName(server: Pick<McpServer, "name">, tool: string, taken: Set<string>): string {
  const prefix = slugify(server.name).replace(/-/g, "_") || "mcp";
  const base = `${prefix}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, TOOL_NAME_MAX);
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, TOOL_NAME_MAX - String(n).length - 1)}_${n}`;
  taken.add(name);
  return name;
}

type Opts = { caller: McpCaller; config: BotToolConfig | null; taken: Set<string>;
  authority?: { ctx: AgentCtx; binding: string; grants: ServiceGrant[] } };
export type McpToolset = { entries: ToolEntry[]; close: () => Promise<void> };

/** A tool call after its turn closed the toolset (a stream still running after the turn ended): never reconnects. */
export class McpToolsetClosedError extends Error {
  constructor(serverName: string) {
    super(`"${serverName}" can't be used any more: this reply has already ended.`);
    this.name = "McpToolsetClosedError";
  }
}

function selected(defs: McpToolDef[], config: BotToolConfig | null) {
  return config?.tools ? defs.filter((t) => config.tools!.includes(t.name)) : defs;
}

function buildEntries(server: McpServer, defs: McpToolDef[], getClient: (caller?: McpCaller) => Promise<MCPClient>, opts: Opts,
  ensureOpen: () => void, releaseClient: (client: MCPClient) => Promise<void>): ToolEntry[] {
  const budget = server.resultBudgetKb * 1024;
  return defs.map((def) => {
    // Property descriptions reach the model too: clean the whole schema, not only the tool description.
    const schema = JSON.parse(stripHidden(JSON.stringify(def.inputSchema))) as McpToolDef["inputSchema"];
    const authority = opts.authority;
    const service = authority?.ctx.bot?.executionMode === "service";
    const grant = service ? checkedServiceGrant(server, authority.grants, def, authority.ctx.bot!.revision) : null;
    const inputSchema = { ...schema, properties: schema.properties ?? {}, additionalProperties: false };
    const validateInput = mcpInputValidator(inputSchema, service);
    const validate = (input: unknown) => {
      validateInput(input);
      if (grant) assertArgumentConstraints(input, grant.constraints, authority!.ctx.principal.user);
    };
    return {
      name: modelToolName(server, def.name, opts.taken),
      key: `mcp:${server.id}`,
      mcp: {
        tool: def.name,
        definitionHash: toolHash(def),
        readOnly: grant ? grant.effect === "read" : def.annotations?.readOnlyHint === true,
        destructive: grant ? grant.effect === "write" : def.annotations?.destructiveHint === true,
        trusted: server.trust === "trusted",
        requireApproval: server.toolPolicy[def.name]?.requireApproval === true || !!grant?.requireApproval,
        override: grant ? (grant.requireApproval ? "ask" : "auto") : opts.config?.approvals?.[def.name],
      },
      validateInput: validate,
      ...(grant ? { grantable: false } : {}),
      tool: dynamicTool({
        description: (cleanDescription(def.description ?? def.title ?? def.annotations?.title) ?? "") +
          (grant ? `\nRequired scope (exact values): ${JSON.stringify(grant.constraints.map((c) => ({
            path: c.path, equals: c.source === "constant" ? c.value : authority!.ctx.principal.user[c.source.slice(7) as "id" | "upn" | "email"],
          })))}` : ""),
        inputSchema: jsonSchema(inputSchema as JSONSchema7, { validate: async (value) => {
          try { validate(value); return { success: true, value }; }
          catch {
            if (authority) await audit(authority.ctx.principal.user.id, "mcp.call.denied", server.id, {
              bot: authority.ctx.bot?.id, revision: authority.ctx.bot?.revision, grant: grant?.id ?? null,
              service: service ? `bot:${authority.ctx.bot!.id}` : null, tool: def.name,
              conversation: authority.ctx.conversationId, run: authority.ctx.usage?.runId,
              inputHash: sha256Hex(canonicalJson(value)), reason: "schema-or-scope",
            });
            return { success: false, error: new Error("Tool arguments do not match the reviewed schema or scope.") };
          }
        } }),
        toModelOutput: mcpResultToModelOutput,
        async execute(input, { abortSignal, toolCallId }) {
          const ctx = authority?.ctx;
          const details = { bot: ctx?.bot?.id, revision: ctx?.bot?.revision, service: service ? `bot:${ctx?.bot?.id}` : null,
            grant: grant?.id ?? null, server: server.id, tool: def.name, run: ctx?.usage?.runId, call: toolCallId,
            conversation: ctx?.conversationId, delegation: ctx?.delegationPath ?? [],
            inputHash: sha256Hex(canonicalJson(input ?? {})), approvalRequired: !!grant?.requireApproval || !!server.toolPolicy[def.name]?.requireApproval };
          const check = () => authority ? authorizeMcpInvocation(authority.ctx, authority.binding, server, def, input) : Promise.resolve(null);
          let client: MCPClient;
          try {
            ensureOpen();
            validate(input);
            if (authority) await check();
            // A service call has its own signed grant identity; never share mutable identity between concurrent calls.
            client = grant ? await getClient({ ...opts.caller, service: {
              id: `bot:${ctx!.bot!.id}`, grant: grant.id, revision: grant.botRevision, server: server.id,
              tool: def.name, run: ctx!.usage?.runId, call: toolCallId,
            } }) : await getClient();
          } catch (err) {
            if (ctx) await audit(ctx.principal.user.id, "mcp.call.denied", server.id, details);
            if (err instanceof McpToolsetClosedError) throw err;
            throw new Error(`"${server.name}" is unavailable right now: ${mcpErrorMessage(err, server)}`);
          }
          try {
            if (authority) await check(); // the connection handshake may outlive a revocation
            ensureOpen();
            if (ctx) await audit(ctx.principal.user.id, "mcp.call.authorized", server.id, details);
            const result = await client.callTool({
              name: def.name,
              arguments: (input ?? {}) as Record<string, unknown>,
              options: { signal: abortSignal, timeout: server.timeoutMs },
            });
            if (ctx) await audit(ctx.principal.user.id, "mcp.call.completed", server.id, details);
            return capResult(redactMcpValue(result as McpCallResult, server), budget);
          } catch (err) {
            if (ctx) await audit(ctx.principal.user.id, "mcp.call.failed", server.id, details);
            if (abortSignal?.aborted) throw err;
            throw new Error(`${def.name} on "${server.name}" failed: ${mcpErrorMessage(err, server)}`);
          } finally {
            if (grant) await releaseClient(client);
          }
        },
      }),
    };
  });
}

/**
 * A server's tools from its accepted snapshot. Nothing connects until the model calls one of them, so a turn that
 * uses no MCP tool opens no connections; the connection is then reused for the rest of the turn. Once closed, calls
 * fail instead of opening a new connection nobody would close.
 */
export function mcpTools(server: McpServer, opts: Opts): McpToolset {
  const defs = selected(offeredTools(server), opts.config);
  let pending: Promise<MCPClient> | null = null;
  let closed = false;
  const connections = new Set<Promise<MCPClient>>();
  const released = new WeakSet<MCPClient>();
  const ensureOpen = () => { if (closed) throw new McpToolsetClosedError(server.name); };
  const releaseClient = async (client: MCPClient) => {
    if (released.has(client)) return;
    released.add(client);
    await client.close().catch(() => {});
  };
  const open = (caller: McpCaller) => {
    const connection = connectMcp(server, caller).then(async (client) => {
      if (closed) {
        await releaseClient(client);
        throw new McpToolsetClosedError(server.name);
      }
      client.toolsFromDefinitions({ tools: defs as never });
      return client;
    });
    connections.add(connection);
    return connection;
  };
  const getClient = (caller?: McpCaller) => {
    if (closed) return Promise.reject(new McpToolsetClosedError(server.name));
    if (caller) return open(caller); // per-call service identity, tracked by turn cleanup
    return pending ??= open(opts.caller).catch((err) => {
      if (!closed) pending = null;
      throw err;
    });
  };
  return {
    entries: buildEntries(server, defs, getClient, opts, ensureOpen, releaseClient),
    close: async () => {
      closed = true;
      pending = null;
      await Promise.allSettled([...connections].map((p) => p.then(releaseClient)));
      connections.clear();
    },
  };
}

/**
 * Servers enabled before tool snapshots existed (no accepted list yet): connect and list now, as before. The
 * worker's refresh captures their snapshot soon after an upgrade, and from then on they load lazily.
 */
export async function connectedMcpTools(server: McpServer, opts: Opts): Promise<McpToolset> {
  const client = await connectMcp(server, opts.caller);
  try {
    const all = await listAllTools(client, { timeout: server.timeoutMs });
    const defs = selected(
      all.filter((t) => server.toolPolicy[t.name]?.enabled !== false),
      opts.config,
    );
    let closed = false;
    const getClient = async () => {
      if (closed) throw new McpToolsetClosedError(server.name);
      return client;
    };
    return {
      entries: buildEntries(server, defs, getClient, opts, () => {
        if (closed) throw new McpToolsetClosedError(server.name);
      }, async () => {}),
      close: () => {
        closed = true;
        return client.close();
      },
    };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}
