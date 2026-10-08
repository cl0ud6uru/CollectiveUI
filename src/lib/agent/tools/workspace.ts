/**
 * Workspace tools (P5): commands and file operations in the acting person's own sandbox. Output is cleaned and capped
 * inside `execute`, before it is streamed, stored or shown, so every copy (browser, message parts, tool_calls, later
 * replays) is bounded and has secrets masked. Failures are results, not throws, so the model and the person see the
 * real message.
 *
 * Only workspace_bash runs a shell. The read-only tools use sandboxd's argv-only helpers.
 */
import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { SandboxError } from "@/lib/sandbox/client";
import { artifactLink } from "@/lib/chat/workspace-artifacts";
import { capHeadTail, cleanText, isHardDenied, looksBinary } from "@/lib/sandbox/policy";
import type { PortalWorkspace } from "@/lib/sandbox/session";
import type { SandboxSettings } from "@/lib/settings";
import type { ToolEntry } from "../types";

const KEY = "workspace";
const MASK = "[redacted]";

/** A command's id in the sandbox, derived from the tool call so a Stop button can find it again. */
export const execIdForToolCall = (toolCallId: string) => createHash("sha256").update(toolCallId).digest("hex").slice(0, 16);

export type Failure = { ok: false; reason: string; message: string };

function failure(err: unknown): Failure {
  if (err instanceof SandboxError) return { ok: false, reason: err.code, message: err.message };
  return { ok: false, reason: "error", message: cleanText(err instanceof Error ? err.message : String(err)).slice(0, 500) };
}

export type BashOutput =
  | { status: "running"; stdout: string; stderr: string; bytes: number }
  | {
      status: "done";
      ok: boolean;
      exitCode: number;
      reason: string;
      stdout: string;
      stderr: string;
      truncated: boolean;
      durationMs: number;
    }
  | ({ status: "error" } & Failure);

const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n)}` : s);

export function workspaceTools(ws: PortalWorkspace, s: SandboxSettings): ToolEntry[] {
  const budget = Math.max(4096, s.outputKb * 1024);
  const half = Math.floor(budget / 2);
  const readBudget = Math.min(256 * 1024, Math.max(64 * 1024, budget * 4));
  const maxTimeout = s.commandTimeoutSec;

  const bash: ToolEntry = {
    name: "workspace_bash",
    key: KEY,
    sensitive: true,
    grantable: false,
    tool: tool({
      description:
        "Run a bash command in the user's private workspace (Debian, git, python3, node, a C toolchain; no network). " +
        "The working directory is /home/agent/workspace. Workspace permission settings determine whether approval is needed. Batch related steps into one command.",
      inputSchema: z.object({
        command: z.string().min(1).max(16_000).describe("The bash command (runs with bash -c)"),
        cwd: z.string().max(1024).optional().describe("Working directory, relative to the workspace"),
        timeout_seconds: z.number().int().min(1).max(maxTimeout).optional().describe(`Stop after this many seconds (default and max ${maxTimeout})`),
      }),
      async *execute({ command, cwd, timeout_seconds }, { abortSignal, toolCallId }): AsyncGenerator<BashOutput> {
        const blocked = isHardDenied(command);
        if (blocked) {
          yield { status: "error", ok: false, reason: "blocked", message: blocked };
          return;
        }
        let out = "";
        let err = "";
        let bytes = 0;
        let gap = false;
        const decoder = { out: new TextDecoder(), err: new TextDecoder() };
        const updates: BashOutput[] = [];
        let wake: (() => void) | null = null;
        let lastYield = 0;
        const queue = (u: BashOutput) => {
          updates.push(u);
          wake?.();
        };
        const running = ws
          .exec({
            command,
            cwd,
            timeoutMs: (timeout_seconds ?? maxTimeout) * 1000,
            signal: abortSignal,
            execId: execIdForToolCall(toolCallId),
            onFrame: (f) => {
              if (f.t === "out" || f.t === "err") {
                const chunk = Buffer.from(f.d, "base64");
                bytes += chunk.length;
                if (f.t === "out") out += decoder.out.decode(chunk, { stream: true });
                else err += decoder.err.decode(chunk, { stream: true });
                // Keep only what the final result can show: a bounded head and tail per stream.
                if (out.length > 4 * budget) out = out.slice(0, budget) + out.slice(out.length - budget);
                if (err.length > 4 * budget) err = err.slice(0, budget) + err.slice(err.length - budget);
              } else if (f.t === "gap") gap = true;
              // A small tail preview at most twice a second, so a long command doesn't resend its output hundreds of times.
              const now = Date.now();
              if (now - lastYield >= 500) {
                lastYield = now;
                queue({ status: "running", stdout: tail(cleanText(out), 2000), stderr: tail(cleanText(err), 1000), bytes });
              }
            },
          })
          .then(
            (exit) => ({ exit }),
            (error: unknown) => ({ error }),
          );
        let result: Awaited<typeof running> | null = null;
        void running.then((r) => {
          result = r;
          wake?.();
        });
        while (!result || updates.length) {
          if (updates.length) {
            yield updates.shift()!;
            continue;
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
        const r = result as Awaited<typeof running>;
        if ("error" in r) {
          yield { status: "error", ...failure(r.error) };
          return;
        }
        const o = capHeadTail(cleanText(out + decoder.out.decode()), half, half);
        const e = capHeadTail(cleanText(err + decoder.err.decode()), half / 2, half / 2);
        yield {
          status: "done",
          ok: r.exit.code === 0 && r.exit.reason === "exited",
          exitCode: r.exit.code,
          reason: r.exit.reason,
          stdout: o.text,
          stderr: e.text,
          truncated: gap || o.omitted > 0 || e.omitted > 0,
          durationMs: r.exit.ms,
        };
      },
      toModelOutput: ({ output }) => {
        const o = output as BashOutput;
        if (o.status === "error") return { type: "error-text", value: o.message };
        if (o.status === "running") return { type: "text", value: "The command was interrupted before it finished." };
        const why = o.reason === "exited" ? "" : ` (${o.reason === "timeout" ? "timed out" : o.reason === "output_limit" ? "stopped: too much output" : o.reason})`;
        return {
          type: "text",
          value: `exit code ${o.exitCode}${why}, ${(o.durationMs / 1000).toFixed(1)}s${o.truncated ? ", output shortened" : ""}\n--- stdout ---\n${o.stdout}\n--- stderr ---\n${o.stderr}`,
        };
      },
    }),
  };

  const write: ToolEntry = {
    name: "workspace_write",
    key: KEY,
    sensitive: true,
    tool: tool({
      description: "Create or overwrite a text file in the workspace (parent folders are created). To change part of a file, use workspace_edit.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024).describe("Path relative to the workspace"),
        content: z.string().max(1_000_000),
      }),
      async execute({ path, content }) {
        if (content.includes(MASK))
          return { ok: false as const, reason: "redacted", message: `The content contains "${MASK}", a masked secret you saw in a tool result. Don't write it back; use workspace_edit to change only the parts you need.` };
        try {
          const r = await ws.writeRaw(path, new TextEncoder().encode(content));
          return { ok: true as const, path, bytes: r.bytes, created: r.created, ...artifactLink(path) };
        } catch (err) {
          return failure(err);
        }
      },
    }),
  };

  const edit: ToolEntry = {
    name: "workspace_edit",
    key: KEY,
    sensitive: true,
    tool: tool({
      description:
        "Replace text in a workspace file: old_string must match exactly (including whitespace) and be unique unless replace_all is set.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024),
        old_string: z.string().min(1).max(200_000),
        new_string: z.string().max(200_000),
        replace_all: z.boolean().optional(),
      }),
      async execute({ path, old_string, new_string, replace_all }) {
        if (old_string.includes(MASK) || new_string.includes(MASK))
          return { ok: false as const, reason: "redacted", message: `The text contains "${MASK}", a masked secret. Edit around it instead.` };
        try {
          // Read-modify-write under the handle's lock, so parallel edits of one file don't lose changes.
          return await ws.serialize(async () => {
            const file = await ws.readRaw(path, 10 * 1024 * 1024);
            if (!file) return { ok: false as const, reason: "not_found", message: `${path} doesn't exist. Create it with workspace_write.` };
            if (file.truncated) return { ok: false as const, reason: "too_large", message: `${path} is too large to edit this way.` };
            if (looksBinary(file.bytes)) return { ok: false as const, reason: "binary", message: `${path} is a binary file.` };
            const text = new TextDecoder("utf-8", { fatal: false }).decode(file.bytes);
            const count = text.split(old_string).length - 1;
            if (count === 0) return { ok: false as const, reason: "no_match", message: "old_string wasn't found. Read the file again and copy the text exactly." };
            if (count > 1 && !replace_all)
              return { ok: false as const, reason: "ambiguous", message: `old_string appears ${count} times. Include more surrounding text, or set replace_all.` };
            const next = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
            await ws.writeNow(path, new TextEncoder().encode(next));
            return { ok: true as const, path, replacements: replace_all ? count : 1, ...artifactLink(path) };
          });
        } catch (err) {
          return failure(err);
        }
      },
    }),
  };

  const read: ToolEntry = {
    name: "workspace_read",
    key: KEY,
    tool: tool({
      description: "Read a text file from the workspace, with line numbers. Use start_line/end_line for large files. File results include downloadUrl: use that exact URL when sharing a file with the user. For files created by a command, read the file to get its download link.",
      inputSchema: z.object({
        path: z.string().min(1).max(1024),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      }),
      async execute({ path, start_line, end_line }) {
        try {
          const file = await ws.readRaw(path, readBudget, start_line, end_line);
          if (!file) return { ok: false as const, reason: "not_found", message: `${path} doesn't exist.` };
          if (looksBinary(file.bytes)) return { ok: true as const, path, binary: true, size: file.size, ...artifactLink(path) };
          const first = start_line ?? 1;
          const lines = cleanText(file.bytes).split("\n");
          if (lines.at(-1) === "") lines.pop();
          const numbered = lines.map((l, i) => `${String(first + i).padStart(5)}  ${l}`).join("\n");
          return { ok: true as const, path, size: file.size, truncated: file.truncated, content: numbered, ...artifactLink(path) };
        } catch (err) {
          return failure(err);
        }
      },
    }),
  };

  const list: ToolEntry = {
    name: "workspace_list",
    key: KEY,
    tool: tool({
      description: "List files and folders in the workspace (skips .git and node_modules contents).",
      inputSchema: z.object({
        path: z.string().max(1024).optional().describe("Folder relative to the workspace (default: the workspace)"),
        depth: z.number().int().min(1).max(3).optional().describe("How many levels deep (default 2)"),
      }),
      async execute({ path, depth }) {
        try {
          const r = await ws.list({ path, depth: depth ?? 2, maxEntries: 500 });
          return { ok: true as const, entries: r.entries.map((e) => `${e.type === "dir" ? "d" : e.type === "link" ? "l" : "-"} ${cleanText(e.path)}${e.type === "file" ? ` (${e.size} B)` : ""}`), truncated: r.truncated };
        } catch (err) {
          return failure(err);
        }
      },
    }),
  };

  const grep: ToolEntry = {
    name: "workspace_grep",
    key: KEY,
    tool: tool({
      description: "Search the workspace's text files for a regular expression (Python syntax). Returns file:line: text.",
      inputSchema: z.object({
        pattern: z.string().min(1).max(1024),
        path: z.string().max(1024).optional(),
        glob: z.string().max(256).optional().describe('Only files matching this glob, e.g. "*.ts"'),
        ignore_case: z.boolean().optional(),
      }),
      async execute({ pattern, path, glob, ignore_case }) {
        try {
          const r = await ws.grep({ pattern, path, glob, ignoreCase: ignore_case, maxMatches: 200 });
          return { ok: true as const, matches: r.matches.map((m) => `${cleanText(m.path)}:${m.line}: ${cleanText(m.text)}`), truncated: r.truncated };
        } catch (err) {
          return failure(err);
        }
      },
    }),
  };

  return [bash, write, edit, read, list, grep];
}
