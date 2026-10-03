/**
 * Paste-to-import for MCP client configs: Claude Desktop / Claude Code (.mcp.json), Cursor, Windsurf, VS Code
 * (mcp.json or settings.json) and Gemini CLI all share roughly the same shape. Remote (HTTP/SSE) servers become
 * drafts; stdio servers run a local program, which a web portal can't, so they are listed as rejected with the
 * reason. `npx mcp-remote <url>` bridges are unwrapped to the URL they bridge to. Pure: no network, no database.
 */

export type ImportCandidate = { name: string; url: string; transport: "http" | "sse"; headers: Record<string, string>; warnings: string[] };
export type ImportRejection = { name: string; reason: string };
export type ImportResult = { candidates: ImportCandidate[]; rejected: ImportRejection[] };

export const MAX_IMPORT_CHARS = 100_000;
export const MAX_IMPORT_SERVERS = 50;

const PLACEHOLDER = /\$\{[^}]*\}|\$[A-Z_][A-Z0-9_]*/;

/** Removes // and /* *\/ comments and trailing commas outside strings (VS Code files are JSONC). */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else if (c === ",") {
      // Drop trailing commas: look past whitespace and comments for a closing bracket.
      let j = i + 1;
      for (;;) {
        if (/\s/.test(text[j] ?? "")) j++;
        else if (text[j] === "/" && text[j + 1] === "/") while (j < text.length && text[j] !== "\n") j++;
        else if (text[j] === "/" && text[j + 1] === "*") j = text.indexOf("*/", j + 2) < 0 ? text.length : text.indexOf("*/", j + 2) + 2;
        else break;
      }
      if (text[j] !== "}" && text[j] !== "]") out += c;
    } else out += c;
  }
  return out;
}

type Entry = Record<string, unknown>;

function serversMap(json: unknown): Record<string, Entry> {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Paste a JSON object with an mcpServers (or servers) section");
  const o = json as Record<string, unknown>;
  const map = o.mcpServers ?? o.servers ?? (o.mcp as Record<string, unknown> | undefined)?.servers;
  if (map && typeof map === "object" && !Array.isArray(map)) return map as Record<string, Entry>;
  // A bare map of servers: every value looks like a server entry.
  const values = Object.values(o);
  if (values.length && values.every((v) => v && typeof v === "object" && ("url" in v || "command" in v || "serverUrl" in v || "httpUrl" in v)))
    return o as Record<string, Entry>;
  throw new Error("No MCP servers found. Paste the mcpServers section of your client's config.");
}

function transportOf(entry: Entry, url: string): "http" | "sse" | "stdio" | "unknown" {
  const t = String(entry.type ?? entry.transport ?? "").toLowerCase().replace(/[-_]/g, "");
  if (t === "stdio") return "stdio";
  if (t === "sse") return "sse";
  if (t === "http" || t === "streamablehttp") return "http";
  if (t) return "unknown";
  if (entry.httpUrl) return "http";
  return /\/sse\/?$/.test(new URL(url).pathname) ? "sse" : "http";
}

/** `npx -y mcp-remote https://host/mcp --header "Authorization: Bearer x"` → the URL and headers it bridges to. */
function unwrapMcpRemote(entry: Entry): { url: string; headers: Record<string, string> } | null {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (!args.some((a) => /(^|\/)mcp-remote(@[^/]*)?$/.test(a))) return null;
  const url = args.find((a) => /^https?:\/\//i.test(a));
  if (!url) return null;
  const headers: Record<string, string> = {};
  args.forEach((a, i) => {
    if (a === "--header" && args[i + 1]) {
      const h = args[i + 1];
      const k = h.indexOf(":");
      if (k > 0) headers[h.slice(0, k).trim()] = h.slice(k + 1).trim();
    }
  });
  return { url, headers };
}

export function parseMcpConfig(text: string): ImportResult {
  if (text.length > MAX_IMPORT_CHARS) throw new Error("That's too much to import at once");
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch {
    throw new Error("That isn't valid JSON");
  }
  const map = serversMap(json);
  const names = Object.keys(map);
  if (names.length > MAX_IMPORT_SERVERS) throw new Error(`Import at most ${MAX_IMPORT_SERVERS} servers at a time`);

  const result: ImportResult = { candidates: [], rejected: [] };
  for (const rawName of names) {
    const name = rawName.trim().slice(0, 80) || "MCP server";
    const entry = map[rawName];
    if (!entry || typeof entry !== "object") {
      result.rejected.push({ name, reason: "Not a server entry" });
      continue;
    }
    const warnings: string[] = [];
    let url = [entry.url, entry.serverUrl, entry.httpUrl].find((v): v is string => typeof v === "string");
    let headers: Record<string, unknown> = entry.headers && typeof entry.headers === "object" ? (entry.headers as Record<string, unknown>) : {};
    if (!url && entry.command) {
      const bridged = unwrapMcpRemote(entry);
      if (!bridged) {
        result.rejected.push({ name, reason: "Runs a local program (stdio). Put it behind an HTTP bridge or deploy it as a remote MCP server." });
        continue;
      }
      url = bridged.url;
      headers = { ...bridged.headers, ...headers };
      warnings.push("Imported the URL behind mcp-remote; the portal connects to it directly.");
    }
    if (!url) {
      result.rejected.push({ name, reason: "No url" });
      continue;
    }
    try {
      new URL(url);
    } catch {
      result.rejected.push({ name, reason: "Not a valid URL" });
      continue;
    }
    if (PLACEHOLDER.test(url)) {
      result.rejected.push({ name, reason: "The URL uses a variable; paste the real URL" });
      continue;
    }
    const transport = transportOf(entry, url);
    if (transport === "stdio" || transport === "unknown") {
      result.rejected.push({ name, reason: transport === "stdio" ? "Runs a local program (stdio)." : `Unknown transport "${String(entry.type ?? entry.transport)}"` });
      continue;
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v !== "string" || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(k)) {
        warnings.push(`Skipped header "${k}" (not a plain text header).`);
      } else if (PLACEHOLDER.test(v)) {
        // The portal never reads credentials from its own environment, so variables can't be filled in here.
        warnings.push(`Header "${k}" uses a variable; set its real value before enabling.`);
      } else clean[k] = v;
    }
    if (entry.env && typeof entry.env === "object" && Object.keys(entry.env).length) warnings.push("Ignored env (only used by local programs).");
    result.candidates.push({ name, url, transport, headers: clean, warnings });
  }
  return result;
}
