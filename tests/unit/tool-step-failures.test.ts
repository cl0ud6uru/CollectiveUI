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
