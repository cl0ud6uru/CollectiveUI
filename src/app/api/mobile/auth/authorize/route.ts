import { callbackUrl, issueAuthCode, mobileEnabled, parseAuthorizeRequest } from "@/lib/auth/mobile";
import { audit } from "@/lib/audit";
import { errorResponse, requirePrincipal } from "@/lib/session";

/** The consent form on /mobile/authorize: a same-origin POST from a signed-in browser hands the app a one-time code. */
export async function POST(req: Request) {
  try {
    const p = await requirePrincipal();
    const origin = new URL(process.env.AUTH_URL || req.url).origin;
    if (req.headers.get("origin") !== origin || req.headers.get("sec-fetch-site") === "cross-site")
      return Response.json({ error: "Invalid origin" }, { status: 403 });
    if (!mobileEnabled()) return Response.json({ error: "Mobile sign-in is turned off" }, { status: 404 });
    const form = await req.formData();
    const request = parseAuthorizeRequest((name) => form.get(name));
    if (!request) return Response.json({ error: "Invalid sign-in request" }, { status: 400 });
    let location: string;
    if (form.get("decision") === "approve") {
      const code = await issueAuthCode(p, request);
      await audit(p.user.id, "mobile.authorize", p.user.id, { device: request.deviceName });
      location = callbackUrl({ code, state: request.state });
    } else {
      location = callbackUrl({ error: "access_denied", state: request.state });
    }
    return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
