import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Vendor-policy guard rails (docs/architecture/backend-harness.md, invariant I4).
 * Anthropic does not allow third-party apps to offer Claude.ai login, route requests through Claude
 * subscription credentials, or store/relay Claude.ai tokens. Claude subscriptions may only be used by the
 * user signing in to the unmodified Claude Code binary themselves. These checks stop that code from creeping in.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const code = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "dev"))].filter((f) => /\.(ts|tsx|js|mjs|sql)$/.test(f));
const rel = (f: string) => path.relative(ROOT, f);

// Assembled from parts so this file doesn't trip its own scan when src/ is ever scanned more broadly.
const FORBIDDEN = [
  ["claude.ai/oauth", "/authorize"],
  ["platform.claude.com/v1", "/oauth/token"],
  ["console.anthropic.com/v1", "/oauth/token"],
  ["oauth-2025", "-04-20"],
  ["claude-code-", "20250219"],
  ["You are Claude Code, ", "Anthropic's official CLI"],
  ["9d1c250a-e61b-44d9", "-88ed-5944d1962f5e"], // Claude Code's OAuth client id
  ["chatgpt", "AuthTokens"], // Codex app-server's "internal use only" host-token mode
].map((p) => p.join(""));

describe("vendor policy guards", () => {
  it("no Claude OAuth or Claude Code impersonation strings in the code base", () => {
    const hits = code.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return FORBIDDEN.filter((s) => src.includes(s)).map((s) => `${rel(f)}: ${s}`);
    });
    expect(hits).toEqual([]);
  });

  it("no database column that could hold Claude/Anthropic OAuth or session credentials", () => {
    const schema = readFileSync(path.join(ROOT, "src/db/schema.ts"), "utf8");
    const columns = [...schema.matchAll(/\b(?:text|jsonb|varchar)\("([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(columns.length).toBeGreaterThan(20);
    expect(columns.filter((c) => /(claude|anthropic).*(oauth|token|session|cred|cookie)/i.test(c))).toEqual([]);
  });

  it("model provider SDKs are only imported in src/lib/llm/providers (ESLint can't see dynamic import())", () => {
    const pkgs = /["'](@ai-sdk\/(openai|openai-compatible|anthropic|azure|amazon-bedrock|google-vertex|google|gateway|deepseek)(\/[\w-]+)*|aws4fetch|google-auth-library)["']/;
    const src = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
    const hits = src.filter((f) => !rel(f).startsWith(path.join("src", "lib", "llm", "providers")) && pkgs.test(readFileSync(f, "utf8")));
    expect(hits.map(rel)).toEqual([]);
  });

  it("the Anthropic OAuth token option is never used", () => {
    const llm = walk(path.join(ROOT, "src", "lib", "llm")).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(llm.filter((f) => /\bauthToken\b/.test(readFileSync(f, "utf8"))).map(rel)).toEqual([]);
  });

  it("client components only import the client-safe catalog from the model layer", () => {
    const client = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    const bad = client.filter((f) => /from ["']@\/lib\/llm(?!\/catalog["'])[^"']*["']/.test(readFileSync(f, "utf8")));
    expect(bad.map(rel)).toEqual([]);
  });

  it("AI SDK packages are pinned to exact versions (one copy of the provider interfaces)", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
    const loose = Object.entries(deps).filter(([name, v]) => (name === "ai" || name.startsWith("@ai-sdk/")) && !/^\d+\.\d+\.\d+$/.test(v));
    expect(loose).toEqual([]);
  });

  it("no packages that relay Claude subscription credentials", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const denied = ["ai-sdk-provider-claude-code", "@ai-sdk/harness-claude-code", "opencode-anthropic-auth"];
    expect(deps.filter((d) => denied.includes(d))).toEqual([]);
  });

  it("Sign in with ChatGPT identifies as the portal, never as Codex CLI, and never imports a local Codex login", () => {
    // Codex CLI's own originator; the portal sends its own (src/lib/llm/chatgpt/constants.ts).
    const impersonation = ["codex_cli", "_rs"].join("");
    // ~/.codex/auth.json shares a rotating token family with the person's CLI: importing it gets both revoked.
    const cliLogin = [".codex", "/auth.json"].join("");
    const hits = code.filter((f) => {
      const src = readFileSync(f, "utf8");
      return src.includes(impersonation) || src.includes(cliLogin);
    });
    expect(hits.map(rel)).toEqual([]);
  });

  it("encrypted account tokens are only written by their dedicated credential stores", () => {
    const writers = code.filter((f) => /secretEnc\s*:/.test(readFileSync(f, "utf8")) && !f.endsWith("schema.ts"));
    expect(writers.map(rel).sort()).toEqual([
      path.join("src", "lib", "llm", "chatgpt", "store.ts"),
      path.join("src", "lib", "remote-hermes", "store.ts"),
    ]);
  });
});

/**
 * Sandbox plane guard rails (P5). sandboxd is the only process with docker.sock, so it stays small and separate: no
 * portal modules, no npm packages, no portal secrets. Workspaces never hold credentials.
 */
describe("sandbox plane guards", () => {
  const sandboxd = walk(path.join(ROOT, "src", "sandboxd")).filter((f) => /\.ts$/.test(f));

  it("sandboxd imports only node:* and its own files", () => {
    expect(sandboxd.length).toBeGreaterThan(8);
    const bad = sandboxd.flatMap((f) => {
      const src = readFileSync(f, "utf8");
      const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
      return specs
        .filter((spec) => {
          if (spec.startsWith("node:")) return false;
          if (!spec.startsWith(".")) return true;
          // Relative imports must stay inside src/sandboxd and name the .ts file (plain Node has no resolver magic).
          const target = path.resolve(path.dirname(f), spec);
          return !target.startsWith(path.join(ROOT, "src", "sandboxd") + path.sep) || !spec.endsWith(".ts");
        })
        .map((spec) => `${rel(f)}: ${spec}`);
    });
    expect(bad).toEqual([]);
  });

  it("sandboxd never touches portal secrets or the database", () => {
    const names = ["DATABASE_URL", "AUTH_SECRET", "ENCRYPTION_KEY", "TOOL_APPROVAL_SECRET", "@/"];
    const hits = sandboxd.flatMap((f) => names.filter((n) => readFileSync(f, "utf8").includes(n)).map((n) => `${rel(f)}: ${n}`));
    expect(hits).toEqual([]);
  });

  it("sandboxd starts on plain Node (type stripping, no build step)", () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "src", "sandboxd", "index.ts"), "--help"], { encoding: "utf8", env: { PATH: process.env.PATH } as unknown as NodeJS.ProcessEnv });
    expect(r.stderr).not.toMatch(/Error/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/usage: sandboxd/);
  });

  it("exactly one compose service mounts docker.sock, and it gets no env_file", () => {
    const files = readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
    expect(files).toContain("docker-compose.sandbox.yml");
    const holders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(path.join(ROOT, file), "utf8").split("\n");
      // Service blocks: a two-space key under `services:` up to the next one (or the next top-level key).
      let service: string | null = null;
      let inServices = false;
      const blocks = new Map<string, string[]>();
      for (const line of lines) {
        if (/^\S/.test(line)) {
          inServices = /^services:\s*$/.test(line);
          service = null;
          continue;
        }
        const m = inServices ? /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line) : null;
        if (m) {
          service = m[1];
          blocks.set(service, []);
        } else if (service) blocks.get(service)!.push(line);
      }
      for (const [name, body] of blocks) {
        const text = body.filter((l) => !/^\s*#/.test(l)).join("\n");
        if (text.includes("docker.sock")) {
          holders.push(`${file}:${name}`);
          expect(text, `${file}:${name}`).not.toMatch(/env_file/);
          expect(text, `${file}:${name}`).toMatch(/read_only:\s*true/);
          expect(text, `${file}:${name}`).toMatch(/cap_drop:\s*\[ALL\]/);
          expect(text, `${file}:${name}`).toMatch(/no-new-privileges/);
        }
      }
    }
    expect(holders).toEqual(["docker-compose.sandbox.yml:sandboxd"]);
  });

  it("the sandboxd image contains only sandboxd", () => {
    const stage = readFileSync(path.join(ROOT, "Dockerfile"), "utf8").split(/^FROM /m).find((s) => /\bAS sandboxd\b/.test(s.split("\n")[0]));
    expect(stage).toBeDefined();
    expect([...stage!.matchAll(/^COPY\s.*$/gm)].map((m) => m[0])).toEqual(["COPY --chown=root:root src/sandboxd ./src/sandboxd"]);
    expect(stage).toMatch(/^USER node$/m);
  });

  it("the sandboxes table holds no credentials", () => {
    const schema = readFileSync(path.join(ROOT, "src/db/schema.ts"), "utf8");
    const table = /export const sandboxes = pgTable\([\s\S]*?\n\}\)?[^\n]*\n/.exec(schema)?.[0] ?? "";
    expect(table).toMatch(/"ref"/);
    const columns = [...table.matchAll(/\b[a-z]+\("([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(columns.filter((c) => /secret|token|key|cred|password|enc/i.test(c))).toEqual([]);
  });

  it("workspace commands can't be always-allowed: the grant action checks isGrantable", () => {
    const actions = readFileSync(path.join(ROOT, "src/app/(chat)/actions.ts"), "utf8");
    const fn = /export async function grantToolForBot[\s\S]*?\n\}/.exec(actions)?.[0] ?? "";
    expect(fn).toMatch(/isGrantable\(/);
  });

  it("client components import nothing from @/lib/sandbox but types", () => {
    const client = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    const bad = client.filter((f) => /^\s*import\s+(?!type\s)[^;]*from\s+["']@\/(lib\/sandbox|sandboxd)[^"']*["']/m.test(readFileSync(f, "utf8")));
    expect(bad.map(rel)).toEqual([]);
  });
});

/**
 * Durable runs (P6): direct-chat turns execute in the worker (src/lib/runs/execute.ts), never inside the browser's
 * request, so closing the tab can't cut a reply short and Stop is an explicit request.
 */
describe("durable runs guards", () => {
  const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
  // Code only: comment lines may mention runTurn.
  const codeOf = (src: string) => src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("runTurn is used only by the worker and inline task executors", () => {
    const src = walk(path.join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f) && rel(f) !== path.join("src", "lib", "agent", "run.ts"));
    const users = src.filter((f) => /\brunTurn\b/.test(codeOf(readFileSync(f, "utf8")))).map(rel);
    expect(users.filter((f) => !["src/lib/runs/execute.ts", "src/lib/delegation/execute.ts"].includes(f))).toEqual([]);
    expect(read("src/lib/delegation/execute.ts")).not.toMatch(/\benqueueRun\(/);
  });

  it("the chat route doesn't run turns, and the request's abort only reaches the in-request group turn", () => {
    const route = codeOf(read("src/app/api/chat/route.ts"));
    expect(route).not.toMatch(/\brunTurn\b|["']@\/lib\/agent\/run["']/);
    const post = route.slice(route.indexOf("export async function POST"));
    expect(post).not.toMatch(/\.signal\b/);
    const uses = route.split("\n").filter((l) => /\.signal\b/.test(l));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/runGroupTurn\(.*abortSignal: req\.signal/);
  });

  it("the resume and stop endpoints authorize and hide other people's chats", () => {
    for (const f of ["src/app/api/chat/[id]/stream/route.ts", "src/app/api/chat/[id]/stop/route.ts"]) {
      const src = read(f);
      expect(src, f).toMatch(/await requirePrincipal\(\)/);
      expect(src, f).toMatch(/conv\.userId !== p\.user\.id\) throw new HttpError\(404/);
    }
  });

  it("the chat client stops a reply only from Stop, never when the page goes away", () => {
    const chat = codeOf(read("src/components/chat/chat.tsx"));
    expect(chat).toMatch(/\/api\/chat\/\$\{conversationId\}\/stop/);
    expect(chat).not.toMatch(/pagehide|beforeunload|\bunload\b|sendBeacon/);
  });
});
