import { createElement } from "react";
import { Tooltip } from "radix-ui";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/app/(chat)/settings/workspace-actions", () => ({ stopWorkspaceCommand: async () => ({ ok: true }) }));
import { AssistantMessage } from "@/components/chat/message";
import { toolFailureText } from "@/components/chat/steps";
import type { PortalUIMessage } from "@/lib/chat/store";
function render(output: object) {
  const message = { id: "command-error", role: "assistant", parts: [{ type: "tool-workspace_bash", toolCallId: "command", state: "output-available", input: { command: "npm test" }, output }] } as unknown as PortalUIMessage;
  return renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
}
it("keeps an actual workspace failure visible after the turn finishes", () => {
  const html = render({ status: "error", ok: false, reason: "timeout", message: "The command timed out" });
  expect(html).toContain("The command timed out");
});
it("keeps a nonzero command exit visible after the turn finishes", () => {
  const html = render({ status: "done", ok: false, exitCode: 1, reason: "exited", stdout: "", stderr: "Assertion failed", truncated: false, durationMs: 25 });
  expect(html).toContain("Assertion failed");
  expect(html).toContain("failed");
});

it("keeps non-command structured failures visible", () => {
  const message = { id: "write-error", role: "assistant", parts: [{ type: "tool-workspace_write", toolCallId: "write", state: "output-available", input: { path: "notes.txt" }, output: { ok: false, reason: "outside_workspace", message: "Outside the workspace" } }] } as unknown as PortalUIMessage;
  const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
  expect(html).toContain("1 failed");
  expect(html).toContain("Outside the workspace");
});
it("recognizes explicit failure results while preserving progress and success", () => {
  const part = (output: unknown, preliminary = false) => ({ type: "tool-example", toolCallId: "c", state: "output-available", input: {}, output, preliminary }) as Parameters<typeof toolFailureText>[0];
  expect(toolFailureText(part({ isError: true }))).toBe("The tool failed.");
  expect(toolFailureText(part({ status: "error", error: "Unavailable" }))).toBe("Unavailable");
  expect(toolFailureText(part({ status: "done", ok: true }))).toBeNull();
  expect(toolFailureText(part({ results: [{ ok: false }] }))).toBeNull();
  expect(toolFailureText(part({ status: "error" }, true))).toBeNull();
});

it.each([
  ["output-denied", undefined],
  ["approval-responded", { id: "approval-denied", approved: false }],
])("keeps a %s denial visible after the reply finishes", (state, approval) => {
  const message = { id: "denied-call", role: "assistant", parts: [{ type: "tool-example", toolCallId: "denied", state, input: {}, approval }] } as unknown as PortalUIMessage;
  const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
  expect(html).toContain("1 denied");
  expect(html).toContain("— denied");
  expect(html).not.toContain("lucide-check");
  expect(html).not.toContain("Running </span>");
});

it.each(["input-available", "input-streaming"])("keeps an unfinished %s tool visible as interrupted after the reply ends", state => {
  const message = { id: "unfinished-call", role: "assistant", parts: [{ type: "tool-example", toolCallId: "unfinished", state, input: {} }] } as unknown as PortalUIMessage;
  const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
  expect(html).toContain("1 interrupted");
  expect(html).toContain("— interrupted");
  expect(html).not.toContain("lucide-check");
  expect(html).not.toContain("Running </span>");
});

it("lets the delegation card present its sanitized failure exactly once", () => {
  const error = "The assignment is no longer authorized to return a result.";
  const message = { id: "delegate-error", role: "assistant", parts: [{ type: "tool-ask_gemma", toolCallId: "delegate", state: "output-available", input: {}, output: { ok: false, status: "error", error } }] } as unknown as PortalUIMessage;
  const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
  expect(html.split(error)).toHaveLength(2);
});

it("preserves a structured delegation failure not presented by its card", () => {
  const message = { id: "delegate-message-error", role: "assistant", parts: [{ type: "tool-ask_gemma", toolCallId: "delegate", state: "output-available", input: {}, output: { ok: false, status: "done", message: "The delegated workspace is unavailable." } }] } as unknown as PortalUIMessage;
  const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
  expect(html).toContain("The delegated workspace is unavailable.");
});

it("keeps completed steps folded when a finished reply also contains a denial and interruption", () => {
  const message = { id: "mixed-result", role: "assistant", parts: [
    { type: "tool-completed", toolCallId: "done", state: "output-available", input: {}, output: "Completed details stay folded" },
    { type: "tool-denied", toolCallId: "denied", state: "output-denied", input: {} },
    { type: "tool-unfinished", toolCallId: "unfinished", state: "input-available", input: {} },
  ] } as unknown as PortalUIMessage;
  const html = renderToStaticMarkup(createElement(Tooltip.Provider, null, createElement(AssistantMessage, { message, streaming: false, isLast: true, onApprove: () => {}, onDeny: () => {} })));
  expect(html).toContain("3 steps · 1 denied · 1 interrupted");
  expect(html).toContain("Used denied — denied");
  expect(html).toContain("Using unfinished — interrupted");
  expect(html).not.toContain("Completed details stay folded");
});
