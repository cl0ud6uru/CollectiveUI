"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { saveRemoteHermesSettings } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { RemoteHermesSettings } from '@/lib/settings';
import { Card } from './ui';

export function RemoteHermesSettingsCard({ initial }: { initial: RemoteHermesSettings }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [allowSessionYolo, setAllowSessionYolo] = useState(initial.allowSessionYolo === true);
  const [gateways, setGateways] = useState(initial.privateGateways.join('\n'));
  const [pending, start] = useTransition();
  return <Card className="space-y-4">
    <h2 className="font-medium">Personal remote Hermes</h2>
    <label className="flex items-center justify-between gap-3 text-sm">Allow personal remote Hermes connections
      <Switch aria-label="Allow personal remote Hermes connections" checked={enabled} onCheckedChange={setEnabled} disabled={pending} />
    </label>
    <p className="text-sm text-muted">Users connect their own Hermes dashboard accounts. Turning this off blocks new connections, sign-ins and new work. Active runs can finish, receive prompt answers or be stopped. Saved connections are retained. Shared backends and managed/local Hermes remain available.</p>
    <label className="flex items-center justify-between gap-3 text-sm">Allow confirmed session YOLO changes
      <Switch aria-label="Allow confirmed session YOLO changes" checked={allowSessionYolo} onCheckedChange={setAllowSessionYolo} disabled={pending} />
    </label>
    <p className="text-sm text-muted">Off by default. Conversation owners can explicitly confirm bypassing recoverable Hermes approval prompts for an idle conversation on a verified runtime. Other native clients sharing that conversation are affected. This does not permit profile-wide changes or remove Hermes hard deny rules.</p>
    <Field label="Approved private dashboard URLs" hint="One exact dashboard base URL per line for LAN, loopback or Tailscale servers reachable from this portal. Public servers require HTTPS. This does not create a tunnel.">
      <Textarea value={gateways} onChange={e => setGateways(e.target.value)} disabled={pending} rows={3} placeholder="http://hermes.internal:9119" />
    </Field>
    <Button disabled={pending} onClick={() => start(async () => {
      try {
        await saveRemoteHermesSettings({ enabled, allowSessionYolo, privateGateways: gateways.split('\n').map(s => s.trim()).filter(Boolean) });
        toast.success('Remote Hermes policy saved'); router.refresh();
      } catch (e) { toast.error(e instanceof Error ? e.message : 'Save failed'); }
    })}>{pending ? 'Saving…' : 'Save remote Hermes policy'}</Button>
  </Card>;
}
