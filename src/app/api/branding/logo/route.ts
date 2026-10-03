import { logoKey } from "@/lib/branding/store";
import { storage } from "@/lib/files/storage";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Intentionally public: only the active, normalized PNG. No client-supplied file keys. */
export async function GET() {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const { id } = await getSetting("brandingLogo");
  if (!id) return new Response(null, { status: 404, headers });
  try {
    const png = await storage().get(logoKey(id));
    return new Response(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png", "Content-Disposition": 'inline; filename="logo.png"' } });
  } catch {
    // Missing storage (e.g. an incomplete restore) falls back to the configured emoji in the UI.
    return new Response(null, { status: 404, headers });
  }
}
