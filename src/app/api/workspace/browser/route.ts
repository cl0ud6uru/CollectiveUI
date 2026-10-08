import { HttpError } from "@/lib/authz";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { sandboxd, SandboxError } from "@/lib/sandbox/client";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { findSandbox, touchSandbox } from "@/lib/sandbox/store";
import { browserPath, previewFile, PREVIEW_BYTES, type WorkspaceBrowserStatus } from "@/lib/sandbox/browser";

const json = (value: unknown) => Response.json(value, { headers: { "Cache-Control": "private, no-store" } });

export async function GET(req: Request) {
  try {
    const p = await requirePrincipal();
    const settings = await getSetting("sandbox");
    const allowed = userMayUseWorkspace(p, settings);
    const query = new URL(req.url).searchParams;
    if ([...query.keys()].some(k => !["operation", "path"].includes(k)) || query.getAll("operation").length !== 1 || query.getAll("path").length > 1)
      throw new HttpError(400, "Invalid workspace request");
    const operation = query.get("operation");
    if (!["status", "list", "preview"].includes(operation ?? "")) throw new HttpError(400, "Invalid workspace request");
    const client = sandboxd();
    if (operation === "status") {
      const base: WorkspaceBrowserStatus = { allowed, configured: !!client, state: "missing", runtime: null };
      if (!allowed || !client) return json(base);
      const row = await findSandbox(p.user.id);
      if (!row) return json(base);
      try {
        const state = await client.state(row.ref);
        return json({ ...base, state: state.state, runtime: state.runtime });
      } catch { return json({ ...base, state: "unavailable" }); }
    }
    if (!allowed) throw new HttpError(403, "Workspace access is unavailable");
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    const path = browserPath(query.get("path"), operation === "list");
    if (!path) throw new HttpError(400, "Invalid workspace file path");
    // Browsing does not allocate a workspace. A stopped workspace wakes when a person browses its files.
    const row = await findSandbox(p.user.id);
    if (!row) {
      if (operation === "list") return json({ entries: [], truncated: false });
      throw new HttpError(404, "Workspace file not found");
    }
    const isolation = requiredIsolation(settings);
    if (operation === "list") {
      const result = await client.listFiles(row.ref, { isolation, path, depth: 1, maxEntries: 500 });
      await touchSandbox(p.user.id);
      return json({ ...result, entries: result.entries.filter(e => browserPath(e.path)) });
    }
    const file = await client.readFile(row.ref, { isolation, path, maxBytes: PREVIEW_BYTES });
    if (!file) throw new HttpError(404, "Workspace file not found");
    await touchSandbox(p.user.id);
    return json(previewFile(path, file));
  } catch (err) {
    if (err instanceof SandboxError) {
      const status = err.code === "not_found" ? 404 : ["outside_workspace", "bad_request"].includes(err.code) ? 400 : 503;
      return errorResponse(new HttpError(status, status === 400 ? "Invalid workspace file path" : status === 404 ? "Workspace file not found" : "The workspace cannot be opened right now. Try again."));
    }
    return errorResponse(err);
  }
}
