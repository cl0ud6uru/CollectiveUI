import { errorResponse, requirePrincipal } from "@/lib/session";
import { listOwnInstances } from "@/lib/workspaces/instances";

export async function GET() {
  try {
    const instances = await listOwnInstances(await requirePrincipal());
    return Response.json({ instances }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
