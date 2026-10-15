import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ principal: vi.fn(), setting: vi.fn(), find: vi.fn(), findInstance: vi.fn(), read: vi.fn(), touch: vi.fn(), touchInstance: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: (e: { status?: number; message: string }) => Response.json({ error: e.message }, { status: e.status ?? 500 }) }));
vi.mock("@/lib/settings", () => ({ getSetting: f.setting }));
vi.mock("@/lib/sandbox/store", () => ({ findSandbox: f.find, findWorkspaceInstance: f.findInstance, touchSandbox: f.touch, touchWorkspaceInstance: f.touchInstance }));
vi.mock("@/lib/sandbox/client", async original => ({ ...await original<object>(), sandboxd: () => ({ readFile: f.read }) }));
import { ToolPartView } from "@/components/chat/tool-part";

const renderResult = (name: string, output: object) => renderToStaticMarkup(createElement(ToolPartView, {
  part: { type: `tool-${name}`, state: "output-available", input: { id: "record-1" }, output } as never,
  onApprove: vi.fn(), onDeny: vi.fn(),
}));

describe("memory tool collapsed result labels", () => {
  it.each([
    ["forget", { status: "not_found", deleted: false }, "No matching memory changed"],
    ["forget", { status: "repeat_noop", deleted: false }, "No change — same target already checked"],
    ["forget", { status: "unsupported_pending", deleted: false }, "No change — review pending preference"],
    ["forget", { status: "forgotten", deleted: true, recordType: "ordinary_memory" }, "Memory forgotten"],
    ["forget", { status: "forgotten", deleted: true, recordType: "learned_preference" }, "Learned preference forgotten"],
    ["correct_memory", { status: "corrected", corrected: true, recordType: "ordinary_memory" }, "Memory corrected"],
    ["correct_memory", { status: "corrected", corrected: true, recordType: "learned_preference" }, "Learned preference corrected"],
    ["correct_memory", { status: "corrected_pending", corrected: true }, "Correction saved for review"],
  ])("shows an honest collapsed %s result", (name, output, label) => {
    const html = renderResult(name, output);
    expect(html).toContain(label);
    expect(html).toContain('aria-expanded="false"');
  });
});
