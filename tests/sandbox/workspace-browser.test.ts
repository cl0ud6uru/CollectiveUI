import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ ref: "", url: "", secret: "" }));
vi.mock("@/lib/session", () => ({ requirePrincipal: async () => ({ user: { id: "workspace-browser-fixture", upn: "fixture@test" }, groupIds: [], isAdmin: false }), errorResponse: (e: { status?: number; message: string }) => Response.json({ error: e.message }, { status: e.status ?? 500 }) }));
vi.mock("@/lib/settings", () => ({ getSetting: async () => ({ enabled: true, access: "everyone", allowRunc: false, commandTimeoutSec: 15, outputKb: 32 }) }));
vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/sandbox/store", () => ({ findSandbox: async () => ({ ref: fixture.ref }), getOrCreateRef: async () => fixture.ref, touchSandbox: async () => {} }));
vi.mock("@/lib/sandbox/client", async original => {
  const clientModule = await original<typeof import("@/lib/sandbox/client")>();
  return { ...clientModule, sandboxd: () => new clientModule.SandboxdClient({ url: fixture.url, secret: fixture.secret }) };
});
import { SandboxdClient } from "@/lib/sandbox/client";
import { POST as terminal } from "@/app/api/workspace/terminal/route";
import { POST as upload } from "@/app/api/workspace/upload/route";
import { GET } from "@/app/api/workspace/browser/route";
const enabled = process.env.SANDBOX_BROWSER_TEST === "1";
fixture.ref = randomBytes(10).toString("hex");
fixture.url = process.env.SANDBOX_BROWSER_URL ?? "http://127.0.0.1:4200";
fixture.secret = process.env.SANDBOX_BROWSER_SECRET ?? "";
let used = false;
afterAll(async () => { if (used) await new SandboxdClient({ url: fixture.url, secret: fixture.secret }).destroy(fixture.ref); });
describe.skipIf(!enabled)("workspace browser routes with the real gVisor daemon", () => {
  it("executes a user command through the route and streams real gVisor output", async () => {
    process.env.AUTH_URL = "https://fixture.test"; used = true;
    const response = await terminal(new Request("https://fixture.test/api/workspace/terminal", { method: "POST", headers: { origin: "https://fixture.test", "Content-Type": "application/json" }, body: JSON.stringify({ command: "printf 'workspace-browser-live\\n'; uname -r" }) }));
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(e => e.type === "output").map(e => e.text).join("")).toContain("workspace-browser-live\n");
    expect(events.filter(e => e.type === "output").map(e => e.text).join("")).toContain("gvisor");
    expect(events.at(-1)).toMatchObject({ type: "exit", code: 0 });
  });
  it("uploads, lists and previews real workspace bytes without accessing an existing user's workspace", async () => {
    process.env.AUTH_URL = "https://fixture.test"; used = true;
    const body = new FormData(); body.set("file", new File(["hostname,status\nDEVLINUX,ready\n"], "inventory.csv"));
    const response = await upload(new Request("https://fixture.test/api/workspace/upload", { method: "POST", headers: { origin: "https://fixture.test" }, body }));
    expect(response.status).toBe(200);
    const { path } = await response.json();
    const preview = await GET(new Request(`https://fixture.test/api/workspace/browser?operation=preview&path=${encodeURIComponent(path)}`));
    expect((await preview.json()).text).toBe("hostname,status\nDEVLINUX,ready\n");
    const listing = await GET(new Request("https://fixture.test/api/workspace/browser?operation=list"));
    expect((await listing.json()).entries).toContainEqual(expect.objectContaining({ path: "uploads", type: "dir" }));
  });
});
