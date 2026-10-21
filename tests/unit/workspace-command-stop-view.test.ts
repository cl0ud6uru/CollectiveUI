import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/app/(chat)/settings/workspace-actions", () => ({ stopWorkspaceCommand: vi.fn() }));
import { BashResult } from "@/components/chat/workspace-parts";

it("enables Stop only after the actual command preview identifies its instance and execution", () => {
  const button = (output?: unknown) => renderToStaticMarkup(createElement(BashResult, { live: true,
    part: { toolCallId: "speaker:provider-call", state: output ? "output-available" : "input-available", preliminary: true, input: { command: "sleep 10" }, output },
  })).match(/<button\b[^>]*aria-label="Stop command"[^>]*>/)?.[0];
  expect(button()).toMatch(/\sdisabled(?:=|\s|>)/);
  expect(button({ status: "running", stdout: "", stderr: "", bytes: 0 })).toMatch(/\sdisabled(?:=|\s|>)/);
  expect(button({ status: "running", stdout: "", stderr: "", bytes: 0, workspaceInstanceId: "template-instance", workspaceExecutionId: "a".repeat(16) })).not.toMatch(/\sdisabled(?:=|\s|>)/);
  expect(button({ status: "running", stdout: "", stderr: "", bytes: 0, workspaceInstanceId: null, workspaceExecutionId: "a".repeat(16) })).not.toMatch(/\sdisabled(?:=|\s|>)/);
});
