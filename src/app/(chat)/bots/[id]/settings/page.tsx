import Link from 'next/link';
import { PageFrame } from '@/components/page-frame';
import { HermesProfileSettings } from '@/components/settings/hermes-profile-settings';
import { requirePagePrincipal } from '@/lib/session';
import { getUsableBot } from '@/lib/authz';
import { personalProfileBinding } from '@/lib/docker-hermes/store';

export default async function ProfileSettingsPage(props: PageProps<'/bots/[id]/settings'>) {
  const p = await requirePagePrincipal(), { id } = await props.params;
  await personalProfileBinding(p, id);
  const bot = await getUsableBot(p, id);
  return <PageFrame title={`${bot.name} · Hermes settings`}>
    <div className="mx-auto max-w-2xl space-y-6">
      <Link href={`/bots/${id}`} className="text-sm underline">Back to {bot.name}</Link>
      <HermesProfileSettings botId={id} />
    </div>
  </PageFrame>;
}
