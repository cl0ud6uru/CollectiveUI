import { Smartphone } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { mobileEnabled, parseAuthorizeRequest } from "@/lib/auth/mobile";
import { getPublicBranding } from "@/lib/branding/store";
import { requirePagePrincipal } from "@/lib/session";

export const metadata = { title: "Sign in on your device" };

/**
 * Consent step of the native app sign-in. The app opens this page in a system browser sheet; signing in (if needed)
 * happens on the normal login page, which returns here. Approving posts to /api/mobile/auth/authorize.
 */
export default async function MobileAuthorizePage(props: PageProps<"/mobile/authorize">) {
  const p = await requirePagePrincipal();
  const sp = await props.searchParams;
  const request = parseAuthorizeRequest((name) => (typeof sp[name] === "string" ? sp[name] : undefined));
  const branding = await getPublicBranding();

  let body: React.ReactNode;
  if (!mobileEnabled()) {
    body = <p className="text-sm text-muted">Mobile sign-in is turned off on this server. Ask your administrator to enable the {branding.appName} app.</p>;
  } else if (!request) {
    body = <p className="text-sm text-muted">This sign-in link is incomplete or has expired. Close this window and try signing in from the app again.</p>;
  } else {
    body = (
      <>
        <p className="text-sm text-muted">
          <strong className="text-fg">{request.deviceName}</strong> wants to sign in to {branding.appName} as{" "}
          <strong className="text-fg">{p.user.name}</strong>{p.user.email ? ` (${p.user.email})` : ""}.
        </p>
        <p className="text-sm text-muted">
          Only approve if you just started signing in from the app. You can sign the device out at any time in Settings → Security.
        </p>
        <form method="post" action="/api/mobile/auth/authorize" className="flex flex-wrap gap-3 pt-2">
          <input type="hidden" name="code_challenge" value={request.codeChallenge} />
          <input type="hidden" name="code_challenge_method" value="S256" />
          <input type="hidden" name="state" value={request.state} />
          <input type="hidden" name="device_name" value={request.deviceName} />
          <Button type="submit" name="decision" value="approve">Approve</Button>
          <Button type="submit" name="decision" value="deny" variant="outline">Cancel</Button>
        </form>
      </>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-bg p-6 text-fg">
      <div className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-surface p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <BrandMark logoUrl={branding.logoUrl} logoEmoji={branding.logoEmoji} className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-semibold">Sign in on your device</h1>
            <p className="flex items-center gap-1 text-xs text-subtle"><Smartphone aria-hidden="true" size={13} />{branding.appName} for iOS</p>
          </div>
        </div>
        {body}
      </div>
    </main>
  );
}
