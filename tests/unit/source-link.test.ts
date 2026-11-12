import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceLink } from "@/components/chat/source-link";

const render = (url: string, title?: string) => renderToStaticMarkup(createElement(SourceLink, { url, title }));
describe("provider source links", () => {
  it("retains normal web citations and their host fallback", () => {
    expect(render("https://example.test/path")).toContain(">example.test</a>");
    expect(render("http://example.test/path", "Reference")).toContain(">Reference</a>");
  });
  it.each(["", "not a URL", "/relative", "https://[", "javascript:alert(1)", "data:text/html,hello", "file:///etc/passwd"])("renders %s without crashing or creating an unsafe link", url => {
    expect(render(url)).toContain(">Unavailable source</span>");
    expect(render(url, "Citation label")).toContain(">Citation label</span>");
    expect(render(url)).not.toContain("href=");
  });
});
