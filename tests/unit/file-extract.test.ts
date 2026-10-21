import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractText, MAX_EXTRACTED_CHARS } from "@/lib/files/extract";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function docx(body: string) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function pdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("attachment text extraction", () => {
  it("reads DOCX and PDF text", async () => {
    expect(await extractText(await docx("<w:p><w:r><w:t>Hello docx</w:t></w:r></w:p>"), DOCX, "a.docx")).toBe("Hello docx");
    expect(await extractText(pdf("Hello pdf"), "application/pdf", "a.pdf")).toContain("Hello pdf");
  });

  it("clamps long documents", async () => {
    const text = await extractText(await docx(`<w:p><w:r><w:t>${"x".repeat(MAX_EXTRACTED_CHARS + 5000)}</w:t></w:r></w:p>`), DOCX, "long.docx");
    expect(text?.endsWith("…[truncated]")).toBe(true);
    expect(text!.length).toBeLessThan(MAX_EXTRACTED_CHARS + 20);
  });

  it("gives up on a decompression bomb without exhausting this process", async () => {
    // ~70 KB compressed, ~34 MB of tiny paragraphs: several GB of parser memory, enough to abort a 2 GB server heap.
    const bomb = await docx("<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(1_000_000));
    expect(bomb.length).toBeLessThan(128 * 1024);
    const before = process.memoryUsage().heapUsed;
    expect(await extractText(bomb, DOCX, "bomb.docx")).toBeNull();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(200 * 1024 * 1024);
  }, 60_000);

  it("returns null for unreadable files", async () => {
    expect(await extractText(Buffer.from("not a zip"), DOCX, "bad.docx")).toBeNull();
    expect(await extractText(Buffer.from("not a pdf"), "application/pdf", "bad.pdf")).toBeNull();
  });
});
