import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { artifactPath, MAX_ARTIFACT_BYTES } from "@/lib/chat/workspace-artifacts";
import { sandboxd, SandboxError } from "@/lib/sandbox/client";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { findSandbox, touchSandbox } from "@/lib/sandbox/store";

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const settings = await getSetting("sandbox");
    if (!userMayUseWorkspace(p, settings)) throw new HttpError(403, "Workspace access is unavailable");
    const query = new URL(req.url).searchParams;
    const path = query.getAll("path").length === 1 ? artifactPath(query.get("path")) : null;
    if (!path || [...query.keys()].some((key) => key !== "path")) throw new HttpError(400, "Invalid workspace file path");
    // Even an admin can download only their own workspace. Never allocate a workspace for a download.
    const workspace = await findSandbox(p.user.id);
    if (!workspace) throw new HttpError(404, "Workspace file not found");
    const client = sandboxd();
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    const file = await client.readFile(workspace.ref, { isolation: requiredIsolation(settings), path, maxBytes: MAX_ARTIFACT_BYTES });
    if (!file) throw new HttpError(404, "Workspace file not found");
    if (file.truncated || file.size > MAX_ARTIFACT_BYTES || file.bytes.length > MAX_ARTIFACT_BYTES) throw new HttpError(413, "Workspace files can be downloaded up to 10 MB");
    await touchSandbox(p.user.id);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1)!).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "Content-Length": String(file.bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch (err) {
    if (err instanceof SandboxError) {
      const status = err.code === "not_found" ? 404 : ["outside_workspace", "bad_request"].includes(err.code) ? 400 : err.code === "too_large" ? 413 : 503;
      return errorResponse(new HttpError(status, status === 400 ? "Invalid workspace file path" : status === 404 ? "Workspace file not found" : "Workspace file cannot be downloaded right now"));
    }
    return errorResponse(err);
  }
}
