import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { artifactPath, MAX_ARTIFACT_BYTES } from "@/lib/chat/workspace-artifacts";
import { sandboxd, SandboxError } from "@/lib/sandbox/client";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { findSandbox, findWorkspaceInstance, touchSandbox, touchWorkspaceInstance } from "@/lib/sandbox/store";

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const settings = await getSetting("sandbox");
    if (!userMayUseWorkspace(p, settings)) throw new HttpError(403, "Workspace access is unavailable");
    const query = new URL(req.url).searchParams;
    const path = query.getAll("path").length === 1 ? artifactPath(query.get("path")) : null;
    const instanceIds = query.getAll("instanceId");
    const instanceId = instanceIds.length === 1 ? instanceIds[0] : undefined;
    if (!path || [...query.keys()].some((key) => key !== "path" && key !== "instanceId") ||
      (instanceIds.length > 0 && (!instanceId || !/^[A-Za-z0-9_-]{8,64}$/.test(instanceId)))) {
      throw new HttpError(400, "Invalid workspace file path");
    }
    // Even an admin can download only their own workspace. Never allocate a workspace for a download.
    const instance = instanceId ? await findWorkspaceInstance(p.user.id, instanceId) : null;
    const workspace = instanceId ? instance : await findSandbox(p.user.id);
    if (!workspace) throw new HttpError(404, "Workspace file not found");
    const client = sandboxd();
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    const ref = instance ? instance.sandboxRef : "ref" in workspace ? workspace.ref : workspace.sandboxRef;
    const profileKey = instance && instance.runtimeProfileKey !== "legacy" ? instance.runtimeProfileKey : undefined;
    const file = await client.readFile(ref, {
      isolation: requiredIsolation(settings), path, maxBytes: MAX_ARTIFACT_BYTES,
      ...(profileKey ? { runtimeProfileKey: profileKey } : {}),
    });
    if (!file) throw new HttpError(404, "Workspace file not found");
    if (file.truncated || file.size > MAX_ARTIFACT_BYTES || file.bytes.length > MAX_ARTIFACT_BYTES) throw new HttpError(413, "Workspace files can be downloaded up to 10 MB");
    if (instance) await touchWorkspaceInstance(instance.id, p.user.id);
    else await touchSandbox(p.user.id);
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
