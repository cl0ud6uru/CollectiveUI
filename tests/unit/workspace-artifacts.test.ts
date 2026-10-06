import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/authz";
import { SandboxError } from "@/lib/sandbox/client";
import { artifactLink, artifactPath, MAX_ARTIFACT_BYTES, workspaceArtifact } from "@/lib/chat/workspace-artifacts";
import { isMobileApiPath } from "@/lib/public-routes";
const f = vi.hoisted(() => ({ principal: vi.fn(), setting: vi.fn(), find: vi.fn(), read: vi.fn(), touch: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePrincipal: f.principal, errorResponse: (e: {status?: number;message: string}) => Response.json({error:e.message},{status:e.status ?? 500}) }));
vi.mock("@/lib/settings", () => ({ getSetting: f.setting }));
vi.mock("@/lib/sandbox/store", () => ({ findSandbox: f.find, touchSandbox: f.touch }));
vi.mock("@/lib/sandbox/client", async (original) => ({ ...await original<object>(), sandboxd: () => ({ readFile: f.read }) }));
import { GET } from "@/app/api/workspace/files/route";
const request = (query = "path=drawing.svg") => new Request(`https://portal.test/api/workspace/files?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  f.principal.mockResolvedValue({ user: {id:"owner",upn:"owner@test"}, groupIds:[], isAdmin:false });
  f.setting.mockResolvedValue({ enabled:true, access:"everyone", allowRunc:false });
  f.find.mockResolvedValue({ref:"ownersandbox"});
  f.read.mockResolvedValue({bytes:Buffer.from('<svg onload="alert(1)"/>'),size:24,truncated:false});
});
describe("workspace artifact ownership and serving", () => {
  it("downloads exact bytes from the authenticated owner's ref and never renders active SVG", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<svg onload="alert(1)"/>');
    expect(f.find).toHaveBeenCalledWith("owner");
    expect(f.read).toHaveBeenCalledWith("ownersandbox", {isolation:"gvisor",path:"drawing.svg",maxBytes:MAX_ARTIFACT_BYTES});
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''drawing.svg");
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it.each(["path=../secret", "path=%2Fetc%2Fpasswd", "path=a%2F..%2Fb", "path=a%5Cb", "path=a%00b", "path=C%3Afile", "path=a&path=b", "path=a&ref=foreign", "path=a&userId=foreign"])("rejects unsafe path or ownership substitution %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("keeps admin downloads owner scoped", async () => {
    f.principal.mockResolvedValue({user:{id:"admin",upn:"admin@test"},groupIds:[],isAdmin:true});
    await GET(request());
    expect(f.find).toHaveBeenCalledWith("admin");
  });
  it("does not read files when unauthenticated or access revoked", async () => {
    f.principal.mockRejectedValueOnce(new HttpError(401,"Unauthorized"));
    expect((await GET(request())).status).toBe(401);
    f.setting.mockResolvedValueOnce({enabled:false});
    expect((await GET(request())).status).toBe(403);
    expect(f.read).not.toHaveBeenCalled();
  });
  it("reports missing workspaces/files and oversized/truncated files", async () => {
    f.find.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(404);
    f.read.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(404);
    f.read.mockResolvedValueOnce({bytes:Buffer.from("x"),size:1,truncated:true});
    expect((await GET(request())).status).toBe(413);
    f.read.mockResolvedValueOnce({bytes:Buffer.from("x"),size:MAX_ARTIFACT_BYTES+1,truncated:false});
    expect((await GET(request())).status).toBe(413);
  });
  it("maps symlink escape to a safe error without daemon paths", async () => {
    f.read.mockRejectedValueOnce(new SandboxError("outside_workspace","secret server path"));
    const response = await GET(request());
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("secret");
  });
  it("encodes Unicode, quotes and literal percent once in the filename", async () => {
    const response = await GET(request(`path=${encodeURIComponent("art/hé '100%.svg")}`));
    expect(response.headers.get("Content-Disposition")).toContain("h%C3%A9%20%27100%25.svg");
  });
});
describe("artifact links", () => {
  it("supports command-created files through read results and normalizes workspace absolute paths", () => {
    expect(artifactLink("/home/agent/workspace/art/100%.svg")).toEqual({downloadUrl:"/api/workspace/files?path=art%2F100%25.svg"});
    expect(workspaceArtifact("workspace_read", {ok:true,path:"art.svg",downloadUrl:"https://evil.test"})?.downloadUrl).toBe("/api/workspace/files?path=art.svg");
    expect(workspaceArtifact("workspace_bash", {ok:true,path:"art.svg"})).toBeNull();
    expect(workspaceArtifact("workspace_write", {ok:false,path:"art.svg"})).toBeNull();
    expect(artifactLink("./art/../drawing.svg")).toEqual({downloadUrl:"/api/workspace/files?path=drawing.svg"});
    expect(artifactPath("../a")).toBeNull();
    expect(isMobileApiPath("/api/workspace/files")).toBe(true);
    expect(isMobileApiPath("/api/workspace/files/foreign")).toBe(false);
  });
});
