/** ESM entrypoint; no SSH principal or pairing is provisioned by this command. */
import { pathToFileURL } from 'node:url';
import { runOfficialPlanReceiver } from '../src/lib/hermes-team/official-plan-companion-stdio';
import type { OfficialPlanCompanionReceiver } from '../src/lib/hermes-team/official-plan-companion-receiver';

/** A deployment must supply an approved gateway adapter deriving the current Principal independently of stdin. */
export const VERIFIED_OFFICIAL_RECEIVER_DRIVERS: readonly (() => Promise<OfficialPlanCompanionReceiver>)[] = Object.freeze([]);
export async function officialPlanReceiverMain(drivers = VERIFIED_OFFICIAL_RECEIVER_DRIVERS) {
  try { if (!drivers[0]) throw new Error(); await runOfficialPlanReceiver(process.stdin, process.stdout, await drivers[0]()); }
  catch { process.stderr.write('Approved SIWC receiver installation and authentication are unavailable in this build.\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await officialPlanReceiverMain();
