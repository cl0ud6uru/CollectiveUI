/** ESM entrypoint; production installation drivers remain empty. */
import { pathToFileURL } from 'node:url';
import { runOfficialPlanLocalCommand } from '../src/lib/hermes-team/official-plan-companion-stdio';

export async function officialPlanLocalMain(args: string[]) {
  try { if (args.length !== 1) throw new Error(); process.stdout.write(`${JSON.stringify(await runOfficialPlanLocalCommand(args[0]))}\n`); }
  catch { process.stderr.write('Approved local SIWC installation and pairing are unavailable in this build.\n'); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await officialPlanLocalMain(process.argv.slice(2));
