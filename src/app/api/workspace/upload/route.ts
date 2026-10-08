import { HttpError } from "@/lib/authz";
import { assertAuthOrigin } from "@/lib/auth/origin";
import { audit } from "@/lib/audit";
import { errorResponse, requirePrincipal } from "@/lib/session";
import { getSetting } from "@/lib/settings";
import { MAX_ARTIFACT_BYTES } from "@/lib/chat/workspace-artifacts";
import { browserPath } from "@/lib/sandbox/browser";
import { sandboxd, SandboxError } from "@/lib/sandbox/client";
import { requiredIsolation, userMayUseWorkspace } from "@/lib/sandbox/policy";
import { getOrCreateRef, touchSandbox } from "@/lib/sandbox/store";

export async function POST(req: Request) {
  try {
    assertAuthOrigin(req.headers);
    const p = await requirePrincipal();
    const settings = await getSetting("sandbox");
    if (!userMayUseWorkspace(p, settings)) throw new HttpError(403, "Workspace access is unavailable");
    if (!req.headers.get("content-type")?.startsWith("multipart/form-data")) throw new HttpError(400, "Choose a file to upload");
    // Bound the streamed request too; a forged/missing Content-Length cannot bypass the allocation limit.
    const reader = req.body?.getReader();
    if (!reader) throw new HttpError(400, "Choose a file to upload");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_ARTIFACT_BYTES + 16384) { await reader.cancel(); throw new HttpError(413, "Upload files up to 10 MB"); }
      chunks.push(value);
    }
    const body = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": req.headers.get("content-type")! } }).formData();
    const file = body.get("file");
    const directory = browserPath(body.get("directory"), true);
    if (!(file instanceof File) || !file.name || file.name.includes("/") || file.name.includes("\\") || body.getAll("file").length !== 1 || body.getAll("directory").length > 1 || !directory || [...body.keys()].some(k => !["file", "directory"].includes(k)))
      throw new HttpError(400, "Invalid upload");
    if (file.size > MAX_ARTIFACT_BYTES) throw new HttpError(413, "Upload files up to 10 MB");
    // Each upload gets a fresh folder; never write onto a user/bot-selected existing file.
    const folder = `uploads/${randomBytes(12).toString("hex")}`;
    const path = browserPath(`${directory === "." ? "" : `${directory}/`}${folder}/${file.name}`);
    if (!path) throw new HttpError(400, "Invalid file name");
    const client = sandboxd();
    if (!client) throw new HttpError(503, "Workspace service is unavailable");
    const ref = await getOrCreateRef(p.user.id);
    const isolation = requiredIsolation(settings);
    const result = await client.writeFile(ref, { isolation, path, contentB64: Buffer.from(await file.arrayBuffer()).toString("base64") });
    await touchSandbox(p.user.id);
    await audit(p.user.id, "workspace.upload", undefined, { bytes: result.bytes });
    return Response.json({ path, bytes: result.bytes }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof SandboxError) return errorResponse(new HttpError(503, "The file could not be uploaded. Check the workspace and try again."));
    return errorResponse(err);
  }
}
import { randomBytes } from "node:crypto";
