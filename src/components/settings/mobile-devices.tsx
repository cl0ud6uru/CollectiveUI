import { Smartphone } from "lucide-react";
import { revokeMobileDevice } from "@/app/(chat)/settings/mobile-actions";
import { listMobileSessions, mobileEnabled } from "@/lib/auth/mobile";
import { requirePagePrincipal } from "@/lib/session";

const date = (d: Date) => d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Native app sign-ins (src/lib/auth/mobile.ts), each revocable. Hidden while the app is off and nothing is signed in. */
export async function MobileDevices() {
  const p = await requirePagePrincipal();
  const devices = await listMobileSessions(p);
  if (!mobileEnabled() && !devices.length) return null;
  return <div className="space-y-3 rounded-xl border border-border p-4 text-sm" data-testid="mobile-devices">
    <div className="flex items-center justify-between gap-3">
      <h3 className="font-medium">Signed-in devices</h3>
      {devices.length > 1 && <form action={revokeMobileDevice.bind(null, undefined)}><button className="min-h-11 text-danger underline">Sign out all</button></form>}
    </div>
    {devices.length ? <ul className="divide-y divide-border">
      {devices.map((d) => <li key={d.id} className="flex items-center gap-3 py-2">
        <Smartphone aria-hidden="true" size={18} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{d.deviceName}</div>
          <div className="text-xs text-subtle">Signed in {date(d.createdAt)} · last active {date(d.lastUsedAt)} · expires {date(d.expiresAt)}</div>
        </div>
        <form action={revokeMobileDevice.bind(null, d.id)}><button className="min-h-11 underline">Sign out</button></form>
      </li>)}
    </ul> : <p className="text-muted">No devices are signed in. Use the iOS app and choose Sign in to add one.</p>}
  </div>;
}
