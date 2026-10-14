/** Explicit self-hosted owner import. Tokens are read from a protected file, never from args or browser requests. */
import { pool } from '../src/db';
import { loadPrincipal } from '../src/lib/auth/groups';
import { importSIWCProfile } from '../src/lib/llm/chatgpt/account';
import { readProtectedSIWCProfile } from '../src/lib/llm/chatgpt/siwc';
import { HttpError } from '../src/lib/authz';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--user-id' || args[2] !== '--file' || !/^[a-zA-Z0-9_-]{1,256}$/.test(args[1])) throw new Error('Invalid arguments');
  if (!process.env.DATABASE_URL || !process.env.CHATGPT_SIWC_HOST_ID) throw new Error('Explicit installation configuration required');
  const actor = await loadPrincipal(args[1]);
  if (!actor || actor.user.disabled) throw new HttpError(403, 'The selected CollectiveUI account is unavailable.');
  const profile = await readProtectedSIWCProfile(args[3]);
  await importSIWCProfile(actor, profile);
  console.log('Your ChatGPT profile is imported. Refresh Settings → Connected accounts. Keep the selected local profile protected for reconnecting with the same client registration.');
}
main().catch(error => {
  console.error(error instanceof HttpError ? error.message : 'ChatGPT import failed. Check the protected file, signed account identity and installation configuration. No credentials were logged.');
  process.exitCode = 1;
}).finally(() => pool.end());
