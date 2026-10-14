import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, Input, Select, Textarea } from "@/components/ui/input";

describe("Field accessibility", () => {
  it("connects a visible label to an otherwise unnamed numeric input", () => {
    const html = renderToStaticMarkup(h(Field, { label: "Max attachments per message", children: h(Input, { type: "number", defaultValue: 10 }) }));
    const target = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
    expect(target).toBeTruthy();
    expect(html).toContain(`id="${target}"`);
    expect(html).toContain(">Max attachments per message</label>");
  });

  it("preserves explicit IDs and ARIA names and appends the visible hint to existing descriptions", () => {
    const html = renderToStaticMarkup(h(Field, {
      label: "API key", hint: "Leave blank to keep the stored key.",
      children: h("div", null, h(Textarea, { id: "secret", "aria-labelledby": "custom-name", "aria-describedby": "validation", defaultValue: "" }), h("button", null, "Test")),
    }));
    expect(html).toContain('for="secret"');
    expect(html).toContain('id="secret"');
    expect(html).toContain('aria-labelledby="custom-name"');
    const hintId = html.match(/<p id="([^"]+)"/)?.[1];
    expect(hintId).toBeTruthy();
    expect(html).toContain(`aria-describedby="validation ${hintId}"`);
    expect(html).toContain("<button>Test</button>");
  });

  it("associates the custom Select trigger and raw native inputs", () => {
    for (const control of [h(Select, { defaultValue: "one", children: h("option", { value: "one" }, "One") }), h("input", { type: "text" })]) {
      const html = renderToStaticMarkup(h(Field, { label: "Voice connection", hint: "Choose a connection", children: control }));
      const target = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
      const hintId = html.match(/<p id="([^"]+)"/)?.[1];
      expect(target).toBeTruthy();
      expect(html).toContain(`id="${target}"`);
      expect(html).toContain(`aria-describedby="${hintId}"`);
    }
  });

  it("names custom control groups without replacing their individual names", () => {
    function Picker() { return h("button", { "aria-label": "Select engineering" }, "Engineering"); }
    const html = renderToStaticMarkup(h(Field, { label: "Groups with access", hint: "Choose all that apply", children: h(Picker) }));
    expect(html).toContain("<fieldset");
    expect(html).toContain(">Groups with access</legend>");
    expect(html).toContain('aria-label="Select engineering"');
    expect(html).not.toContain("<label");
  });

  it("gives repeated controls unique IDs and preserves specific accessible names", () => {
    const html = renderToStaticMarkup(h(Field, { label: "Conversation starters", children: h(Fragment, null, h(Input, { id: "first", "aria-label": "First starter" }), h("div", null, h(Input), h(Input))) }));
    const ids = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map(match => match[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(html).toContain('aria-label="First starter"');
    const labelId = html.match(/<legend id="([^"]+)"/)?.[1];
    expect(html.match(new RegExp(`aria-labelledby="${labelId}"`, "g"))).toHaveLength(2);
  });
});
