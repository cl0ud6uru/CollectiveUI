import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(), deleteApp: vi.fn(), deleteGroup: vi.fn(), saveGroup: vi.fn(), testAppConnection: vi.fn(), listOpenRouterModels: vi.fn(),
  error: vi.fn(), success: vi.fn(), slots: [] as unknown[], cursor: 0,
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = initial;
    return [mocks.slots[index], (next: unknown) => { mocks.slots[index] = typeof next === "function" ? next(mocks.slots[index]) : next; }];
  },
  useRef: (initial: unknown) => {
    const index = mocks.cursor++;
    if (!(index in mocks.slots)) mocks.slots[index] = { current: initial };
    return mocks.slots[index];
  },
  useTransition: () => [false, (action: () => unknown) => action()],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("sonner", () => ({ toast: { error: mocks.error, success: mocks.success } }));
vi.mock("@/app/admin/actions", () => ({ deleteApp: mocks.deleteApp, deleteGroup: mocks.deleteGroup, testAppConnection: mocks.testAppConnection, saveApp: vi.fn() }));
vi.mock("@/app/admin/provider-actions", () => ({ migrateAppProviderConnection: vi.fn() }));
// Next replaces this Server Action import with a client reference. Vitest needs the same boundary mocked.
vi.mock("@/app/admin/model-catalog-actions", () => ({ listOpenRouterModels: mocks.listOpenRouterModels }));
vi.mock("@/app/admin/groups/ldap-actions", () => ({ deleteGroupWithFeedback: mocks.deleteGroup, findLdapUserForGroup: vi.fn(), saveGroupWithFeedback: mocks.saveGroup }));

import { AppsAdmin, type AppRow } from "@/components/admin/apps-admin";
import { GroupsAdmin } from "@/components/admin/groups-admin";

type NodeProps = { children?: ReactNode; "aria-label"?: string; onClick?: () => Promise<void> | void; disabled?: boolean; app?: unknown; connections?: unknown; role?: string; group?: unknown; onClose?: () => void };
function find(node: ReactNode, predicate: (node: ReactElement<NodeProps>) => boolean): ReactElement<NodeProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const found = find(child, predicate); if (found) return found; }
  } else if (isValidElement<NodeProps>(node)) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
}
function render<T>(component: () => T) { mocks.cursor = 0; return component(); }
const app: AppRow = {
  id: "model", name: "Test model", provider: "openai-compatible", baseUrl: "https://provider.example/v1", model: "test", config: {}, groupIds: [], hasKey: false, isPublic: true,
  description: null, icon: null, systemPrompt: null, temperature: null, maxTokens: null, supportsVision: false, supportsTools: true, embeddingModel: null, enabled: true, sortOrder: 0,
};
const group = { id: "group", name: "Engineering", mappings: [], isAdmin: false, canCreateBots: true };
const apps = () => AppsAdmin({ apps: [app], groups: [], chatgptEnabled: false });
const groups = () => GroupsAdmin({ groups: [group], known: [], users: [] });
const button = (tree: ReactNode, label: string) => {
  const found = find(tree, node => node.props["aria-label"] === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};

beforeEach(() => { vi.clearAllMocks(); mocks.slots = []; mocks.cursor = 0; vi.stubGlobal("confirm", vi.fn(() => true)); });
afterEach(() => {
  expect(mocks.listOpenRouterModels).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("admin delete feedback", () => {
  for (const [name, component, label, action] of [
    ["model", apps, "Delete Test model", mocks.deleteApp],
    ["group", groups, "Delete Engineering", mocks.deleteGroup],
  ] as const) {
    it(`keeps the ${name} row and allows retry after a failed deletion, preventing duplicate requests`, async () => {
      let reject!: (reason: Error) => void;
      action.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
      const first = button(render(component), label);
      const pending = first.props.onClick!();
      expect(button(render(component), label).props.disabled).toBe(true);
      await first.props.onClick!();
      expect(action).toHaveBeenCalledTimes(1);
      reject(new Error("You no longer have permission"));
      await pending;
      expect(mocks.error).toHaveBeenCalledWith("You no longer have permission");
      expect(mocks.refresh).not.toHaveBeenCalled();
      const retry = button(render(component), label);
      expect(retry.props.disabled).toBe(false);
      action.mockResolvedValueOnce(name === "group" ? { ok: true } : undefined);
      await retry.props.onClick!();
      expect(mocks.refresh).toHaveBeenCalledTimes(1);
      expect(mocks.success).toHaveBeenCalledTimes(1);
    });
    it(`does not delete a ${name} when confirmation is canceled`, async () => {
      vi.mocked(confirm).mockReturnValueOnce(false);
      await button(render(component), label).props.onClick!();
      expect(action).not.toHaveBeenCalled();
    });
  }
  it("exposes group editing as a native keyboard-operable button", () => {
    const edit = button(render(groups), "Edit Engineering");
    expect(edit.type).toBe("button");
    edit.props.onClick!();
    expect(mocks.slots[0]).toEqual(group);
  });
  it("keeps a blocked group deletion retryable and displays its handoff guidance", async () => {
    const message = "This change would remove your administrator access. Ask another administrator to perform an intentional handoff.";
    mocks.deleteGroup.mockResolvedValueOnce({ ok: false, error: message });
    await button(render(groups), "Delete Engineering").props.onClick!();
    expect(mocks.error).toHaveBeenCalledWith(message);
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(button(render(groups), "Delete Engineering").props.disabled).toBe(false);
    expect(find(render(groups), node => node.props.role === "alert")?.props.children).toBe(message);
  });
  it("keeps a blocked group edit open with persistent handoff guidance", async () => {
    button(render(groups), "Edit Engineering").props.onClick!();
    const dialog = find(render(groups), node => "group" in node.props)!;
    const Dialog = dialog.type as (props: typeof dialog.props) => ReactNode;
    const close = vi.fn(); mocks.slots = [];
    const renderDialog = () => render(() => Dialog({ ...dialog.props, onClose: close }));
    const message = "Ask another administrator to perform an intentional handoff.";
    mocks.saveGroup.mockResolvedValueOnce({ ok: false, error: message });
    const save = find(renderDialog(), node => node.props.children === "Save")!;
    await save.props.onClick!();
    expect(find(renderDialog(), node => node.props.role === "alert")?.props.children).toBe(message);
    expect(close).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

it("reports unexpected connection-test errors and enables retry without losing form values", async () => {
  const dialog = find(render(apps), node => "app" in node.props)!;
  const Dialog = dialog.type as (props: typeof dialog.props) => ReactNode;
  mocks.slots = [];
  const renderDialog = () => render(() => Dialog({ ...dialog.props, app }));
  const testButton = (tree: ReactNode) => find(tree, node => Array.isArray(node.props.children) && node.props.children.includes(" Test"))!;
  let reject!: (reason: Error) => void;
  mocks.testAppConnection.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const tree = renderDialog();
  const first = testButton(tree);
  expect(first).toBeDefined();
  const pending = first.props.onClick!();
  expect(testButton(renderDialog()).props.disabled).toBe(true);
  await first.props.onClick!();
  expect(mocks.testAppConnection).toHaveBeenCalledTimes(1);
  reject(new Error("The service is temporarily unavailable"));
  await pending;
  expect(mocks.error).toHaveBeenCalledWith("The service is temporarily unavailable");
  const retry = testButton(renderDialog());
  expect(retry.props.disabled).toBe(false);
  expect(mocks.slots[0]).toEqual(app);
  mocks.testAppConnection.mockResolvedValueOnce({ ok: true, models: ["test"] });
  await retry.props.onClick!();
  expect(mocks.success).toHaveBeenCalledWith("Connected — 1 model(s)");
});
