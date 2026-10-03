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

export async function extractText(data: Buffer, mediaType: string, filename: string): Promise<string | null> {
  try {
    if (mediaType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
      const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(data));
      const { text } = await pdfText(pdf, { mergePages: true });
      return clamp(Array.isArray(text) ? text.join("\n\n") : text);
    }
    if (
      mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      filename.toLowerCase().endsWith(".docx")
    ) {
      const mammoth = await import("mammoth");
      const { value } = await mammoth.extractRawText({ buffer: data });
      return clamp(value);
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
