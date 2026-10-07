import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ admin: vi.fn(), get: vi.fn(), save: vi.fn(), check: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("@/lib/session", () => ({ requireAdmin: h.admin }));
vi.mock("@/lib/settings", () => ({ getSetting: h.get, setSetting: h.save }));
vi.mock("@/lib/sandbox/setup-server", () => ({ readWorkspaceSetup: h.check }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
import { checkWorkspaceSetup } from "@/app/admin/workspace-setup-actions";
import { saveSandboxSettings } from "@/app/admin/actions";

const initial = { enabled: false, access: "selected" as const, allowedGroupIds: [], allowedUpns: [], allowRunc: false,
  commandTimeoutSec: 120, outputKb: 32, deleteAfterDays: 30 };
beforeEach(() => {
  vi.resetAllMocks(); h.admin.mockResolvedValue({ user: { id: "admin", upn: "admin@fixture.invalid" }, isAdmin: true });
  h.get.mockResolvedValue(initial); h.check.mockResolvedValue({ ready: true });
});

describe("workspace admin setup gates", () => {
  it.each(["Unauthorized", "Admin only"])("rejects %s before reading config or saving", async message => {
    h.admin.mockRejectedValue(new Error(message));
    await expect(checkWorkspaceSetup()).rejects.toThrow(message);
    await expect(saveSandboxSettings({ ...initial, enabled: true, acknowledgeEnable: true })).rejects.toThrow(message);
    expect(h.get).not.toHaveBeenCalled(); expect(h.check).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it("check uses saved policy without granting access or saving settings", async () => {
    await checkWorkspaceSetup(); expect(h.check).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.save).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it("requires enable confirmation even when health is ready", async () => {
    await expect(saveSandboxSettings({ ...initial, enabled: true })).rejects.toThrow("Confirm who");
    expect(h.check).not.toHaveBeenCalled(); expect(h.save).not.toHaveBeenCalled();
  });
  it("fresh readiness check blocks stale browser success", async () => {
    h.check.mockResolvedValue({ ready: false });
    await expect(saveSandboxSettings({ ...initial, enabled: true, acknowledgeEnable: true })).rejects.toThrow("prerequisites are not ready");
    expect(h.save).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it("keeps weaker isolation behind its separate acknowledgement", async () => {
    await expect(saveSandboxSettings({ ...initial, enabled: true, acknowledgeEnable: true, allowRunc: true })).rejects.toThrow("weaker isolation");
    expect(h.save).not.toHaveBeenCalled();
    await saveSandboxSettings({ ...initial, allowRunc: true, acknowledgeRunc: true });
    expect(h.save).toHaveBeenCalledWith("sandbox", expect.objectContaining({ enabled: false, allowRunc: true, runcAcknowledgedBy: "admin@fixture.invalid" }));
  });
  it("saves confirmed access/default limits and audits without confirmation tokens", async () => {
    await saveSandboxSettings({ ...initial, enabled: true, acknowledgeEnable: true, allowedGroupIds: ["trusted"], allowedUpns: ["ALICE@fixture.invalid"] });
    expect(h.check).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.save).toHaveBeenCalledWith("sandbox", expect.objectContaining({ ...initial, enabled: true, allowedGroupIds: ["trusted"], allowedUpns: ["alice@fixture.invalid"] }));
    expect(h.audit).toHaveBeenCalledWith("admin", "settings.sandbox", undefined, { ...initial, enabled: true, allowedGroupIds: ["trusted"], allowedUpns: 1 });
  });
  it("allows saving assignments while off and disabling during an outage", async () => {
    await saveSandboxSettings({ ...initial, allowedGroupIds: ["trusted"] });
    h.get.mockResolvedValue({ ...initial, enabled: true });
    await saveSandboxSettings(initial);
    expect(h.check).not.toHaveBeenCalled(); expect(h.save).toHaveBeenCalledTimes(2);
  });
});
