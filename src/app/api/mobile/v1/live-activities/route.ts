import { requireMobileSession, errorResponse } from "@/lib/session";
import { apnsConfig } from "@/lib/live-activities/apns";
import { activityBody } from "@/lib/live-activities/request";
import { registration, removal } from "@/lib/live-activities/protocol";
import { registerActivity, registrationError, removeActivities } from "@/lib/live-activities/store";

export async function POST(req: Request) {
  try {
    const { principal, session } = await requireMobileSession();
    if (!apnsConfig()) return Response.json({ error: "Background activities unavailable" }, { status: 503 });
    const parsed = registration.safeParse(await activityBody(req));
    if (!parsed.success) return Response.json({ error: "Invalid activity registration" }, { status: 400 });
    const result = await registerActivity(principal, session, parsed.data).catch(registrationError);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    // Configuration/DB errors may contain secret input, so generic response only.
    if (err instanceof Error && "status" in err) return errorResponse(err);
    return Response.json({ error: "Activity service unavailable" }, { status: 503 });
  }
}
export async function DELETE(req: Request) {
  try {
    const { principal, session } = await requireMobileSession();
    const parsed = removal.safeParse(await activityBody(req));
    if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
    await removeActivities(principal.user.id, session.id, parsed.data.activityId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "status" in err) return errorResponse(err);
    return Response.json({ error: "Activity service unavailable" }, { status: 503 });
  }
}
