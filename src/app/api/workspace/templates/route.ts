import { errorResponse, requirePrincipal } from "@/lib/session";
import { listVisibleWorkspaceTemplates } from "@/lib/workspaces/catalog";

export async function GET() {
  try {
    await requirePrincipal();
    const templates = await listVisibleWorkspaceTemplates();
    return Response.json({ templates }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
