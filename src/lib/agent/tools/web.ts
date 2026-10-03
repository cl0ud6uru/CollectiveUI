import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tool } from "ai";
import { z } from "zod";
import { webSearchApiKey } from "@/lib/settings";
import type { AgentCtx, ToolEntry } from "../types";

type SearchResult = { title: string; url: string; snippet: string };

async function search(ctx: AgentCtx, query: string, count: number): Promise<SearchResult[]> {
  const cfg = ctx.toolSettings.webSearch;
  const key = webSearchApiKey(ctx.toolSettings);
  if (cfg.provider === "searxng") {
    const url = new URL("/search", cfg.url);
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const body = (await res.json()) as { results: { title: string; url: string; content?: string }[] };
    return body.results.slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
  }
  if (cfg.provider === "brave") {
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { "X-Subscription-Token": key ?? "", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const body = (await res.json()) as { web?: { results: { title: string; url: string; description: string }[] } };
    return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description }));
  }
  if (cfg.provider === "bing") {
    const res = await fetch(`https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { "Ocp-Apim-Subscription-Key": key ?? "" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const body = (await res.json()) as { webPages?: { value: { name: string; url: string; snippet: string }[] } };
    return (body.webPages?.value ?? []).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet }));
  }
  throw new Error("Web search is not configured. Ask an admin to set a search provider.");
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

export function isPrivateAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  if (isIP(host) === 4) return PRIVATE_V4.some((r) => r.test(host)) || Number(host.split(".")[0]) >= 224;
  if (isIP(host) !== 6) return true;
  // WHATWG normalizes dotted mapped addresses and expanded IPv6 into the same hex representation.
  const v6 = new URL(`http://[${host}]/`).hostname.slice(1, -1).toLowerCase();
  if (v6.startsWith("::ffff:")) {
    const words = v6.slice(7).split(":").map(h => parseInt(h, 16));
    return words.length !== 2 || isPrivateAddress(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
  }
  const first = parseInt(v6.split(":")[0] || "0", 16);
  return v6 === "::1" || v6 === "::" || (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || v6.startsWith("::");
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase();
  return allowlist.some((d) => h === d.toLowerCase() || h.endsWith("." + d.toLowerCase()));
}

/** Resolve once, validate the entire answer, and give the connection only those addresses.
 * An explicit admin allowlist may include internal services; each redirect must pass that same policy.
 */
async function fetchPinned(url: URL, allowlist: string[], signal: AbortSignal): Promise<Response> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowlist.length && !hostAllowed(url.hostname, allowlist)) throw new Error(`Host ${url.hostname} is not on the allowlist`);
  const family = isIP(host);
  const addrs = family ? [{ address: host, family }] : await lookup(host, { all: true });
  if (!addrs.length) throw new Error("Host has no addresses");
  if (!allowlist.length && addrs.some(a => isPrivateAddress(a.address))) throw new Error("Private network addresses are blocked");
  signal.throwIfAborted();
  const address = addrs.find(a => a.family === 4) ?? addrs[0];
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      // Keep the URL hostname for Host, TLS SNI and certificate verification. A fresh connection avoids
      // pools/proxies resolving again; lookup is a fixed answer, never a second DNS request.
      agent: false,
      family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      signal,
      headers: { "User-Agent": "AI-Portal-Bot/1.0", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5", "Accept-Encoding": "identity" },
    }, res => {
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const status = res.statusCode ?? 502;
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new Error(`Invalid HTTP response status: ${status}`));
        return;
      }
      const type = headers.get("content-type") ?? "";
      if (status < 200 || status >= 300 || (type && !/^text\/|json|xml|javascript|yaml|csv|markdown/i.test(type))) {
        res.destroy();
        resolve(new Response(null, { status, headers }));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          reject(new Error("Page exceeds the 2 MB fetch limit"));
          res.destroy();
        } else chunks.push(chunk);
      });
      res.on("end", () => resolve(new Response(status === 204 || status === 205 ? null : Buffer.concat(chunks).toString("utf8"), { status, headers })));
    });
    req.on("error", reject);
    req.end();
  });
}

function htmlToText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
  return { title, text };
}

export function webTools(ctx: AgentCtx): { web_search: ToolEntry; fetch_url: ToolEntry } {
  return {
    web_search: {
      name: "web_search",
      key: "web_search",
      tool: tool({
        description: "Search the web for up-to-date information. Returns titles, URLs and snippets.",
        inputSchema: z.object({
          query: z.string().describe("Search query"),
          count: z.number().int().min(1).max(10).optional(),
        }),
        execute: async ({ query, count }) => ({ results: await search(ctx, query, count ?? 5) }),
      }),
    },
    fetch_url: {
      name: "fetch_url",
      key: "fetch_url",
      tool: tool({
        description: "Fetch a web page or text document and return its readable text.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }, { abortSignal }) => {
          const timeout = AbortSignal.timeout(20_000);
          const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
          let target = new URL(url);
          let res: Response | undefined;
          for (let hop = 0; hop < 4; hop++) {
            res = await fetchPinned(target, ctx.toolSettings.fetchAllowlist, signal);
            const loc = res.headers.get("location");
            if (res.status >= 300 && res.status < 400 && loc) {
              if (hop === 3) throw new Error("Too many redirects");
              target = new URL(loc, target);
              continue;
            }
            break;
          }
          if (!res || !res.ok) throw new Error(`Fetch failed: ${res?.status}`);
          const type = res.headers.get("content-type") ?? "";
          // Binary files (PDFs, images, archives) aren't readable text; their bytes would only be noise to the model.
          if (type && !/^text\/|json|xml|javascript|yaml|csv|markdown/i.test(type)) {
            await res.body?.cancel().catch(() => {});
            return { url: target.toString(), error: `This is a ${type.split(";")[0]} file, which fetch_url can't read as text.` };
          }
          const raw = (await res.text()).slice(0, 2_000_000);
          const { title, text } = type.includes("html") ? htmlToText(raw) : { title: "", text: raw };
          return { url: target.toString(), title, content: text.slice(0, 30_000), truncated: text.length > 30_000 };
        },
      }),
    },
  };
}
