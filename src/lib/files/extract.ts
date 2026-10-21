const TEXT_TYPES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/sql",
];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|java|cs|go|rb|php|sql|sh|ps1|log|ini|toml|c|cpp|h|rs|kt|swift)$/i;

export const MAX_EXTRACTED_CHARS = 200_000;

export function isImage(mediaType: string) {
  return /^image\/(png|jpe?g|gif|webp)$/.test(mediaType);
}

const EXTRACT_TIMEOUT_MS = 30_000;
const EXTRACT_HEAP_MB = 384;
const EXTRACT_CONCURRENCY = 2;

/**
 * PDF and DOCX parsing runs in a short-lived child process with its own heap cap: a small crafted file (a zip or
 * flate bomb) can expand to gigabytes, and running out of heap aborts the whole process, which no catch can stop.
 * A worker thread is not enough: a --max-old-space-size in NODE_OPTIONS overrides its resourceLimits.
 */
const EXTRACTOR_SOURCE = `
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const [kind, maxChars] = process.argv.slice(-2);
  const data = Buffer.concat(chunks);
  let text;
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = require("unpdf");
    ({ text } = await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: true }));
    if (Array.isArray(text)) text = text.join("\\n\\n");
  } else {
    text = (await require("mammoth").extractRawText({ buffer: data })).value;
  }
  process.stdout.write(JSON.stringify(String(text).slice(0, Number(maxChars))), () => process.exit(0));
});
`;

let running = 0;
const waiting: (() => void)[] = [];

async function extractIsolated(kind: "pdf" | "docx", data: Buffer, filename: string): Promise<string | null> {
  if (running >= EXTRACT_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  else running++;
  try {
    const { spawn } = await import("node:child_process");
    return await new Promise<string | null>((resolve) => {
      // Leave room past the cap for clamp()'s trim and NUL removal.
      const child = spawn(process.execPath, [`--max-old-space-size=${EXTRACT_HEAP_MB}`, "-e", EXTRACTOR_SOURCE, "--", kind, String(MAX_EXTRACTED_CHARS + 10_000)], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_OPTIONS: "" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const out: Buffer[] = [];
      let done = false;
      const timer = setTimeout(() => finish(null, "timed out"), EXTRACT_TIMEOUT_MS);
      function finish(text: string | null, error?: string) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) console.error("[extract] failed", filename, error);
        child.kill("SIGKILL");
        resolve(text);
      }
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.on("error", (err) => finish(null, err.message));
      child.on("close", (code, signal) => {
        if (code !== 0) return finish(null, `extractor exited with ${signal ?? `code ${code}`}`);
        try {
          finish(clamp(JSON.parse(Buffer.concat(out).toString("utf8"))));
        } catch {
          finish(null, "extractor returned malformed output");
        }
      });
      child.stdin.on("error", () => {}); // the extractor may exit before reading everything
      child.stdin.end(data);
    });
  } finally {
    // Hand the occupied slot straight to a waiter. Decrementing first lets a new arrival take the slot
    // before the waiter's continuation resumes, exceeding the parser-process cap.
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}

export async function extractText(data: Buffer, mediaType: string, filename: string): Promise<string | null> {
  try {
    if (mediaType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) return await extractIsolated("pdf", data, filename);
    if (
      mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.toLowerCase().endsWith(".docx")
    ) {
      return await extractIsolated("docx", data, filename);
    }
    if (TEXT_TYPES.some((t) => mediaType.startsWith(t)) || TEXT_EXT.test(filename)) {
      return clamp(data.toString("utf8"));
    }
  } catch (err) {
    console.error("[extract] failed", filename, err);
  }
  return null;
}

function clamp(s: string) {
  const t = s.replace(/\u0000/g, "").trim();
  return t.length > MAX_EXTRACTED_CHARS ? t.slice(0, MAX_EXTRACTED_CHARS) + "\n…[truncated]" : t;
}

/** Split text into ~chunkSize character chunks on paragraph boundaries, with overlap. */
export function chunkText(text: string, chunkSize = 1500, overlap = 200): string[] {
  const paras = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n\n" + p).length > chunkSize && cur) {
      chunks.push(cur.trim());
      cur = cur.slice(-overlap) + "\n\n" + p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
    while (cur.length > chunkSize * 1.5) {
      chunks.push(cur.slice(0, chunkSize).trim());
      cur = cur.slice(chunkSize - overlap);
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
