import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import JSZip from "jszip";
import { expect, it } from "vitest";
import { extractText } from "@/lib/files/extract";

async function document() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic document compatibility</w:t></w:r></w:p></w:body></w:document>');
  return zip.generateAsync({ type: "nodebuffer" });
}

it("keeps uploaded DOCX text extraction working with the dependency overrides", async () => {
  expect(await extractText(await document(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "fixture.docx")).toBe("Synthetic document compatibility");
});

it("keeps Mammoth CLI parsing and conversion working with argparse 2", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "collective-docx-"));
  try {
    const filename = path.join(folder, "fixture.docx");
    await writeFile(filename, await document());
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("mammoth/package.json")), "bin/mammoth");
    const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", timeout: 5000 });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--output-format");
    const result = spawnSync(process.execPath, [cli, filename, "--output-format", "html"], { encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("<p>Synthetic document compatibility</p>");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

it("renders inline and display math while keeping untrusted KaTeX commands blocked", () => {
  const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [[remarkMath, { singleDollarTextMath: false }]], rehypePlugins: [rehypeKatex] }, text));
  const html = render('Inline $$a^2+b^2=c^2$$.\n\n$$\n\\frac{1}{2}\n$$');
  expect(html).toContain('class="katex"');
  expect(html).toContain('class="katex-display"');
  expect(html).not.toContain('class="katex-error"');
  expect(render('$$\\href{https://example.com}{untrusted}$$')).not.toContain('href="https://example.com"');
});
