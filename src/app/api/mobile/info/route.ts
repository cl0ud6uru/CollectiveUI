import { mobileEnabled } from "@/lib/auth/mobile";
import { getPublicBranding } from "@/lib/branding/store";

export const dynamic = "force-dynamic";

/** Intentionally public: lets the native app check a server address before sign-in. Only public branding. */
export async function GET() {
  const { appName, logoEmoji } = await getPublicBranding();
  return Response.json({ enabled: mobileEnabled(), appName, logoEmoji, apiVersion: 1 }, { headers: { "Cache-Control": "no-store" } });
}
