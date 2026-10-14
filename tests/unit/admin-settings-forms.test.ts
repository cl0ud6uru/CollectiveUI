import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ToolSettings } from "@/lib/settings";

const fixture = vi.hoisted(() => ({
  settings: {} as ToolSettings,
  save: vi.fn(), testMcp: vi.fn(), saveMcp: vi.fn(), deleteMcp: vi.fn(), refresh: vi.fn(),
  slots: [] as unknown[], cursor: 0,
}));

// Exercise the real component handlers and state without a browser, database or
// network. Each renderer owns its hook slots so parent and dialog state stay separate.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slots = fixture.slots;
    const index = fixture.cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (next: unknown) => { slots[index] = typeof next === "function" ? next(slots[index]) : next; }];
  },
  useTransition: () => [false, (action: () => Promise<void>) => action()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: fixture.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/session", () => ({ requireAdminPage: async () => ({ isAdmin: true }) }));
vi.mock("@/lib/settings", () => ({ getSetting: async (key: string) => key === "tools" ? fixture.settings : {} }));
vi.mock("@/db", () => ({ db: { select: () => ({ from: async () => [] }) } }));
vi.mock("@/db/schema", () => ({ aiApps: {} }));
vi.mock("@/lib/agent/types", () => ({ BUILTIN_TOOLS: [] }));
vi.mock("@/components/admin/voice-form", () => ({ VoiceForm: () => null }));
vi.mock("@/components/admin/decisions-form", () => ({ DecisionsForm: () => null }));
vi.mock("@/app/admin/actions", () => ({
  saveToolSettings: fixture.save,
  testMcpServer: fixture.testMcp,
  saveMcpServer: fixture.saveMcp,
  acceptMcpToolChanges: vi.fn(), deleteMcpServer: fixture.deleteMcp, importMcpServers: vi.fn(),
  previewMcpImport: vi.fn(), rotateMcpIdentitySecret: vi.fn(), setMcpServerEnabled: vi.fn(),
}));
vi.mock("@/app/(chat)/bots/actions", () => ({ revokeServiceBotGrant: vi.fn() }));

import AdminToolsPage from "@/app/admin/tools/page";
import { ToolSettingsForm } from "@/components/admin/tool-settings-form";
import { McpAdmin, type McpServerView } from "@/components/admin/mcp-admin";
import { Button } from "@/components/ui/button";

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function find(node: ReactNode, predicate: (element: Element) => boolean): Element {
  const found = nodes(node).find(predicate);
  if (!found) throw new Error("Expected form control was not rendered");
  return found;
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function renderer<P>(component: (props: P) => ReactNode, initial: P) {
  const slots: unknown[] = [];
  return (props = initial) => {
    fixture.slots = slots; fixture.cursor = 0;
    return component(props);
  };
}
function componentRenderer(element: Element) {
  return renderer(element.type as (props: Element["props"]) => ReactNode, element.props);
}
function button(tree: ReactNode, label: string) {
  return find(tree, node => (node.type === Button || node.type === "button") && text(node).trim() === label);
}
async function click(element: Element) {
  await (element.props.onClick as () => Promise<void> | void)();
}
function change(element: Element, value: string) {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.slots = []; fixture.cursor = 0;
  fixture.settings = {
    disabledTools: [], enforcedApproval: [], fetchAllowlist: [], webSearch: { provider: "none" },
    maxStepsCap: 20, botCreation: "everyone",
    learningEnabled: false, learningRequireApproval: true,
    learningMaintenanceEnabled: false, learningConsolidationEnabled: true,
  };
  fixture.save.mockImplementation(async (value: ToolSettings) => { fixture.settings = { ...value }; });
  fixture.testMcp.mockResolvedValue({ ok: true, result: "unchanged", tools: ["lookup"] });
  fixture.saveMcp.mockResolvedValue({ id: "mcp" });
  fixture.deleteMcp.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("admin learning policy round trips", () => {
  it("preserves non-default learning controls through page load, unrelated edits, save and reload", async () => {
    const expected = {
      learningEnabled: false, learningRequireApproval: true,
      learningMaintenanceEnabled: false, learningConsolidationEnabled: true,
    };
    const page = await AdminToolsPage();
    const form = find(page, node => node.type === ToolSettingsForm);
    expect(form.props.initial).toMatchObject(expected);
    const render = componentRenderer(form);
    let tree = render();
    const learningControls = nodes(tree).filter(node => node.type === "label" && /completed native bot work|every learned skill|Archive unpinned|Consolidate identical/.test(text(node)));
    expect(learningControls.map(label => find(label, node => node.type === "input").props.checked)).toEqual([false, true, false, true]);
    const stepField = find(tree, node => node.props.label === "Max tool steps per run (cap)");
    change(find(stepField, node => node.props.type === "number"), "25");
    tree = render();
    await click(button(tree, "Save changes"));
    expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ ...expected, maxStepsCap: 25 }));
    const reloaded = find(await AdminToolsPage(), node => node.type === ToolSettingsForm);
    await click(button(componentRenderer(reloaded)(), "Save changes"));
    expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining(expected));
  });

  it("retains legacy defaults when the stored settings predate learning controls", async () => {
    delete fixture.settings.learningEnabled;
    delete fixture.settings.learningRequireApproval;
    delete fixture.settings.learningMaintenanceEnabled;
    delete fixture.settings.learningConsolidationEnabled;
    const form = find(await AdminToolsPage(), node => node.type === ToolSettingsForm);
    await click(button(componentRenderer(form)(), "Save changes"));
    expect(fixture.save).toHaveBeenCalledWith(expect.objectContaining({
      learningEnabled: true, learningRequireApproval: false,
      learningMaintenanceEnabled: true, learningConsolidationEnabled: false,
    }));
  });
});

const server: McpServerView = {
  id: "mcp", name: "Directory", description: "Saved description", url: "https://directory.example/mcp",
  transport: "http", hasHeaders: false, isPublic: true, groupIds: [], status: "draft", trust: "untrusted",
  identityHeader: null, hasIdentitySecret: false, resultBudgetKb: 64, timeoutSec: 60,
  tools: [], toolPolicy: {}, drift: null, serverInfo: null, lastTestedAt: null, lastError: null,
};
async function openMcp() {
  const renderParent = renderer(McpAdmin, { servers: [server], groups: [] });
  const edit = find(renderParent(), node => node.type === "button" && node.props["aria-label"] === "Edit Directory");
  expect(edit.props.type).toBe("button");
  await click(edit);
  const dialog = find(renderParent(), node => typeof node.type === "function" && node.type.name === "ServerDialog");
  const close = vi.fn();
  const props: Element["props"] = { ...dialog.props, onClose: close };
  const render = renderer(dialog.type as (props: Element["props"]) => ReactNode, props);
  return { render, props, close };
}

describe("MCP editing and saved configuration tests", () => {
  it.each(["Description", "URL", "Headers (JSON)"])("blocks testing unsaved %s edits and retains the draft", async label => {
    const { render, close } = await openMcp();
    change(find(render(), node => node.props["aria-label"] === label), "Unsaved audit edit");
    const tree = render();
    expect(button(tree, "Test saved server").props.disabled).toBe(true);
    expect(text(tree)).toContain("Save your changes before testing");
    await click(button(tree, "Test saved server"));
    expect(fixture.testMcp).not.toHaveBeenCalled();
    expect(fixture.saveMcp).not.toHaveBeenCalled();
    expect(find(render(), node => node.props["aria-label"] === label).props.value).toBe("Unsaved audit edit");
    expect(close).not.toHaveBeenCalled();
  });

  it("allows testing after reverting an edit, keeps the dialog open and updates refreshed tools", async () => {
    const { render, props, close } = await openMcp();
    change(find(render(), node => node.props["aria-label"] === "Description"), "Changed");
    change(find(render(), node => node.props["aria-label"] === "Description"), server.description!);
    expect(button(render(), "Test saved server").props.disabled).toBe(false);
    await click(button(render(), "Test saved server"));
    expect(fixture.testMcp).toHaveBeenCalledWith(server.id);
    expect(fixture.saveMcp).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(text(render())).toContain("Saved configuration tested successfully. 1 tool available.");
    const refreshed = { ...server, tools: [{ name: "lookup", description: "Find people", readOnly: true, destructive: false }] };
    const tree = render({ ...props, servers: [refreshed] });
    expect(text(tree)).toContain("Find people");
    expect(button(tree, "Enable").props.disabled).toBe(false);
  });

  it.each(["response", "exception"])("retains the form and exposes an inline error for a failed test (%s)", async failure => {
    if (failure === "response") fixture.testMcp.mockResolvedValueOnce({ ok: false, error: "Gateway unavailable" });
    else fixture.testMcp.mockRejectedValueOnce(new Error("Gateway unavailable"));
    const { render, close } = await openMcp();
    await click(button(render(), "Test saved server"));
    const tree = render();
    expect(text(find(tree, node => node.props.role === "alert"))).toContain("Gateway unavailable");
    expect(find(tree, node => node.props["aria-label"] === "Description").props.value).toBe(server.description);
    expect(button(tree, "Test saved server").props.disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("preserves edits made while a saved configuration test is pending", async () => {
    let finish!: (value: { ok: true; result: string; tools: string[] }) => void;
    fixture.testMcp.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { render, close } = await openMcp();
    const pending = click(button(render(), "Test saved server"));
    change(find(render(), node => node.props["aria-label"] === "Description"), "Edit made during test");
    finish({ ok: true, result: "unchanged", tools: ["lookup"] });
    await pending;
    const tree = render();
    expect(find(tree, node => node.props["aria-label"] === "Description").props.value).toBe("Edit made during test");
    expect(button(tree, "Test saved server").props.disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();
  });

  it("blocks tests after changing trust or tool approval policy", async () => {
    const { render, props } = await openMcp();
    const trust = find(render(), node => node.props["aria-label"] === "Trusted server");
    (trust.props.onCheckedChange as (value: boolean) => void)(true);
    expect(button(render(), "Test saved server").props.disabled).toBe(true);
    (find(render(), node => node.props["aria-label"] === "Trusted server").props.onCheckedChange as (value: boolean) => void)(false);
    const withTools = { ...server, tools: [{ name: "lookup", description: "Find people", readOnly: true, destructive: false }] };
    const refreshed = { ...props, servers: [withTools] };
    const approval = find(render(refreshed), node => node.props["aria-label"] === "Require approval for lookup");
    (approval.props.onCheckedChange as (value: boolean) => void)(true);
    expect(button(render(refreshed), "Test saved server").props.disabled).toBe(true);
    expect(fixture.testMcp).not.toHaveBeenCalled();
  });

  it("keeps an issued identity secret visible and permits testing the newly saved configuration", async () => {
    fixture.saveMcp.mockResolvedValueOnce({ id: server.id, identitySecret: "one-time-fixture-secret" });
    const { render, close } = await openMcp();
    (find(render(), node => node.props["aria-label"] === "Send identity").props.onCheckedChange as (value: boolean) => void)(true);
    await click(button(render(), "Save"));
    const tree = render();
    expect(find(tree, node => node.props.secret === "one-time-fixture-secret")).toBeDefined();
    expect(button(tree, "Test saved server").props.disabled).toBe(false);
    await click(button(tree, "Test saved server"));
    expect(close).not.toHaveBeenCalled();
    expect(fixture.testMcp).toHaveBeenCalledWith(server.id);
  });

  it("shows tool drift after a test without closing the editor", async () => {
    fixture.testMcp.mockResolvedValueOnce({ ok: true, result: "drift", tools: ["lookup"] });
    const { render, props, close } = await openMcp();
    await click(button(render(), "Test saved server"));
    const withDrift = { ...server, status: "needs_review", drift: {
      hash: "changed-hash", detectedAt: "2026-10-12T20:00:00Z",
      added: [{ name: "lookup", description: "New directory tool", readOnly: true, destructive: false }], changed: [], removed: [],
    } };
    const tree = render({ ...props, servers: [withDrift] });
    expect(text(tree)).toContain("Review the changes below.");
    expect(text(tree)).toContain("New directory tool");
    expect(button(tree, "Accept changes").props.disabled).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("MCP list action recovery", () => {
  it.each(["Test", "Delete"])("disables actions while %s is pending and restores them after failure", async action => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    let reject!: (reason: Error) => void;
    const operation = action === "Test" ? fixture.testMcp : fixture.deleteMcp;
    operation.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const render = renderer(McpAdmin, { servers: [server], groups: [] });
    const control = () => find(render(), node => node.props["aria-label"] === `${action} Directory`);
    const pending = click(control());
    expect(control().props.disabled).toBe(true);
    expect(find(render(), node => node.props["aria-label"] === "Edit Directory").props.disabled).toBe(true);
    reject(new Error("The server is unavailable. Try again."));
    await pending;
    expect(text(find(render(), node => node.props.role === "alert"))).toContain("Try again.");
    expect(control().props.disabled).toBe(false);
    expect(fixture.refresh).not.toHaveBeenCalled();
    await click(control());
    expect(operation).toHaveBeenCalledTimes(2);
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(nodes(render()).some(node => node.props.role === "alert")).toBe(false);
  });

  it("does not delete when the confirmation is cancelled", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const render = renderer(McpAdmin, { servers: [server], groups: [] });
    await click(find(render(), node => node.props["aria-label"] === "Delete Directory"));
    expect(fixture.deleteMcp).not.toHaveBeenCalled();
    expect(fixture.refresh).not.toHaveBeenCalled();
  });
});
