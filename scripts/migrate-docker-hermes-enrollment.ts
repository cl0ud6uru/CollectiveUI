/** One-time explicit operator import. Never used by web/worker request paths. */
import { pool } from '../src/db';
import { loadPrincipal } from '../src/lib/auth/groups';
import { HttpError } from '../src/lib/authz';
import { importLegacyEnrollment } from '../src/lib/docker-hermes/legacy-enrollment';
async function main() {
  const [mode, actorId] = process.argv.slice(2);
  if (!['--preview', '--apply'].includes(mode) || !actorId || process.argv.length !== 4 || !process.env.DATABASE_URL)
    throw new HttpError(400, 'Usage: npm run hermes:import-enrollment -- --preview|--apply ADMIN_USER_ID with an explicit DATABASE_URL and DOCKER_HERMES_ALLOWED_USER_IDS.');
  const actor = await loadPrincipal(actorId);
  if (!actor?.isAdmin) throw new HttpError(403, 'An existing enabled administrator is required for the audit actor.');
  console.log(JSON.stringify(await importLegacyEnrollment(actor, process.env.DOCKER_HERMES_ALLOWED_USER_IDS ?? '', mode === '--apply'), null, 2));
}
main().catch(error => {
  console.error(error instanceof HttpError ? error.message : 'Import failed. No partial import was committed. Verify database and migration configuration.');
  process.exitCode = 1;
}).finally(() => pool.end());
