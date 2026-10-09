/** ESM entrypoint; production installation drivers remain empty. */
import { pathToFileURL } from 'node:url';
import { runOfficialPlanLocalCommand, VERIFIED_OFFICIAL_LOCAL_DRIVERS } from '../src/lib/hermes-team/official-plan-companion-stdio';

const ACTIONS = ['status', 'sign-in', 'reconnect', 'refresh', 'transfer', 'recover'];
export async function officialPlanLocalMain(args: string[], drivers = VERIFIED_OFFICIAL_LOCAL_DRIVERS) {
  if (args.length !== 1 || !ACTIONS.includes(args[0])) { process.stderr.write(`Usage: official-plan-local <${ACTIONS.join('|')}>\n`); process.exitCode = 2; return; }
  if (!drivers.length) { process.stderr.write('Approved local SIWC installation and pairing are unavailable in this build.\n'); process.exitCode = 1; return; }
  // Runtime failures are not an installation problem; no error detail is echoed since it could carry protocol material.
  try { process.stdout.write(`${JSON.stringify(await runOfficialPlanLocalCommand(args[0], drivers))}\n`); }
  catch { process.stderr.write(`Local SIWC ${args[0]} was not confirmed. Run status before retrying; a suspended session needs recover.\n`); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await officialPlanLocalMain(process.argv.slice(2));
