import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const fixture = vi.hoisted(() => ({ list: vi.fn(), client: vi.fn(), admin: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/admin/actions", () => ({ adminDestroyOrphan: vi.fn(), adminDestroyWorkspaceInstance: vi.fn(), adminStopWorkspaceInstance: vi.fn(), saveSandboxSettings: vi.fn() }));
vi.mock("@/app/admin/workspace-setup-actions", () => ({ checkWorkspaceSetup: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireAdminPage: fixture.admin }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ enabled: false, access: "selected", allowedGroupIds: [], allowedUpns: [], allowRunc: false, commandTimeoutSec: 120, outputKb: 32, deleteAfterDays: 30 }) }));
vi.mock("@/lib/sandbox/client", () => ({ sandboxd: fixture.client }));
vi.mock("@/lib/sandbox/setup-server", () => ({ readWorkspaceSetup: async () => ({ checkedAt: "2026-10-15T12:00:00Z", ready: false, checks: [], hasWarnings: false }) }));
vi.mock("@/lib/sandbox/store", () => ({
  listSandboxRows: async () => [],
  listWorkspaceInstances: async () => [{ id: "workspace", ownerUserId: "owner", sandboxRef: "private-ref", origin: "legacy_personal", provisionState: "ready", lastUsedAt: null, deleteAfter: null }],
}));
vi.mock("@/db", () => ({ db: { select: () => ({ from: () => ({
  orderBy: async () => [], where: async () => [{ id: "owner", name: "Fixture", upn: "owner@fixture.invalid", disabled: true }],
}) }) } }));

import AdminSandboxesPage from "@/app/admin/sandboxes/page";
import { SandboxAdmin, WorkspaceRetentionBadge } from "@/components/admin/sandbox-admin";

function adminProps(tree: ReactNode): React.ComponentProps<typeof SandboxAdmin> {
  const children = (tree as ReactElement<{ children: ReactNode[] }>).props.children;
  const element = children.find(node => isValidElement(node) && node.type === SandboxAdmin) as ReactElement<React.ComponentProps<typeof SandboxAdmin>>;
  return element.props;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SANDBOXD_URL", "http://fixture.invalid:8642");
  vi.stubEnv("SANDBOXD_SECRET", "synthetic-fixture-secret-32-bytes-long");
  fixture.client.mockReturnValue({ list: fixture.list });
});
afterEach(() => vi.unstubAllEnvs());

describe("admin workspace status evidence", () => {
  it.each(["", "https://invalid.invalid"]) ("keeps an unqueried workspace unknown for incomplete/invalid configuration %j", async url => {
    vi.stubEnv("SANDBOXD_URL", url);
    const props = adminProps(await AdminSandboxesPage());
    expect(fixture.client).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    expect(props.rows[0].state).toBe("unknown");
    expect(props.error).toContain("configuration is complete");
    expect(props.setup.ready).toBe(false);
    expect(JSON.stringify(props.rows)).not.toContain("private-ref");
  });

  it("keeps failed or unavailable daemon responses unknown and retryable", async () => {
    fixture.list.mockRejectedValue(new Error("private-service-detail"));
    let props = adminProps(await AdminSandboxesPage());
    expect(fixture.list).toHaveBeenCalledWith(15_000);
    expect(props.rows[0].state).toBe("unknown");
    expect(props.error).toContain("reload this page");
    expect(props.error).not.toContain("private-service-detail");
    fixture.client.mockReturnValue(null);
    props = adminProps(await AdminSandboxesPage());
    expect(props.rows[0].state).toBe("unknown");
  });

  it("infers missing only from a successful list and recovers to the returned state", async () => {
    fixture.list.mockResolvedValue([]);
    expect(adminProps(await AdminSandboxesPage()).rows[0].state).toBe("missing");
    fixture.list.mockResolvedValue([{ ref: "private-ref", state: "stopped", runtime: "runsc", activeExecs: 0 }]);
    const props = adminProps(await AdminSandboxesPage());
    expect(props.rows[0]).toMatchObject({ state: "stopped", runtime: "runsc" });
    expect(props.error).toBeNull();
  });

  it("renders distinct unavailable and absent badges alongside setup guidance and retention context", async () => {
    fixture.list.mockRejectedValue(new Error("offline"));
    const unavailable = renderToStaticMarkup(createElement(SandboxAdmin, adminProps(await AdminSandboxesPage())));
    expect(unavailable).toContain("status unavailable");
    expect(unavailable).not.toContain("not present");
    expect(unavailable).toContain("Run the setup check");
    expect(unavailable).toContain("Completed deletions remove the registered workspace");
    fixture.list.mockResolvedValue([]);
    const absent = renderToStaticMarkup(createElement(SandboxAdmin, adminProps(await AdminSandboxesPage())));
    expect(absent).toContain("not present");
    expect(absent).not.toContain("status unavailable");
  });

  it("denies page access before requesting workspace data", async () => {
    fixture.admin.mockRejectedValue(new Error("Admin only"));
    await expect(AdminSandboxesPage()).rejects.toThrow("Admin only");
    expect(fixture.client).not.toHaveBeenCalled();
  });
});

describe("rendered retention badges at a controlled snapshot", () => {
  const asOf = "2026-10-15T12:00:00Z";
  it("shows the future deadline with its timezone, without claiming completion", () => {
    const html = renderToStaticMarkup(WorkspaceRetentionBadge({ deleteAfter: "2026-10-16T00:10:00Z", asOf }));
    expect(html).toContain("Scheduled for deletion on ");
    expect(html).toContain('dateTime="2026-10-16T00:10:00.000Z"');
    expect(html).toContain("Oct 16, 2026, 12:10:00 AM UTC");
    expect(html).not.toContain("deleted");
  });
  it.each(["2026-10-15T11:59:59Z", asOf])("shows retained overdue/due data pending cleanup at %s", deleteAfter => {
    const html = renderToStaticMarkup(WorkspaceRetentionBadge({ deleteAfter, asOf }));
    expect(html).toContain("Pending cleanup since ");
    expect(html).not.toContain("Scheduled");
    expect(html).not.toContain("deleted");
  });
});
