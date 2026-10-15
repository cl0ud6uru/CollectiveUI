/** CI-only browser acceptance boundary. No application or PostgreSQL imports belong in this module. */
export const ACCEPTED_APP_SHA = '78518aa6b5c35fe37485d8741893fbf361202f9d';
export const EXPECTED_BROWSER_CASES = 10;
const REASONS = new Set([
  'platform_not_linux', 'ci_required', 'github_actions_required', 'explicit_optin_required', 'app_sha_not_accepted',
  'harness_sha_invalid', 'run_identity_invalid', 'service_port_invalid', 'pg_environment_override', 'ambient_configuration',
  'database_url_suffix', 'database_url_invalid', 'database_scheme', 'database_host', 'database_port', 'database_name',
  'database_user', 'database_password', 'source_git_failed', 'source_location', 'source_pin_mismatch', 'source_dirty',
  'ambient_app_env_file', 'unexpected_worker_marker', 'fixture_service_exited', 'fixture_readiness_timeout',
  'database_not_fresh', 'migration_failed', 'synthetic_broker_address', 'browser_cases_not_passed', 'unexpected_failure',
]);
// Only these public, known variable NAMES may be reported. Unknown names may themselves contain private data.
const DIAGNOSTIC_KEYS = new Set([
  'PGAPPNAME', 'PGCHANNELBINDING', 'PGCLIENTENCODING', 'PGCONNECT_TIMEOUT', 'PGDATABASE', 'PGHOST', 'PGHOSTADDR',
  'PGKRBSRVNAME', 'PGOPTIONS', 'PGPASSFILE', 'PGPASSWORD', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGSSLCERT',
  'PGSSLCRL', 'PGSSLKEY', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGTARGETSESSIONATTRS', 'PGUSER',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_CONFIG_DIR', 'AZURE_HTTP_USER_AGENT',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_EC2_METADATA_DISABLED',
  'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CHROME_SHIM',
  'AUTH_MICROSOFT_ENTRA_ID_ID', 'AUTH_MICROSOFT_ENTRA_ID_SECRET', 'LDAP_URL', 'LDAP_ENABLED', 'ENTRA_GRAPH_SCOPES',
  'SANDBOX_URL', 'SANDBOX_TOKEN', 'LOCAL_HERMES_SOCKET', 'DOCKER_HERMES_SOCKET', 'ENCRYPTION_KEY', 'ENCRYPTION_KEYS',
  'ENCRYPTION_PRIMARY_KID', 'TOOL_APPROVAL_SECRET', 'AUTH_SECRET', 'AUTH_URL', 'NODE_OPTIONS',
]);
export class AcceptanceRefusal extends Error {
  constructor(reasonCode, keys = []) {
    super('Disposable Docker Hermes browser environment refused.');
    this.reasonCode = REASONS.has(reasonCode) ? reasonCode : 'unexpected_failure';
    this.environmentKeys = [...new Set(keys.filter(key => DIAGNOSTIC_KEYS.has(key)))].sort();
  }
}
/** Fixed codes and allowlisted key names only; never error messages, paths, URLs or environment values. */
export function acceptanceDiagnostic(error) {
  return error instanceof AcceptanceRefusal
    ? { reasonCode: REASONS.has(error.reasonCode) ? error.reasonCode : 'unexpected_failure',
      ...(Array.isArray(error.environmentKeys) && error.environmentKeys.some(key => DIAGNOSTIC_KEYS.has(key))
        ? { environmentKeys: error.environmentKeys.filter(key => DIAGNOSTIC_KEYS.has(key)) } : {}) }
    : { reasonCode: 'unexpected_failure' };
}
export function browserAcceptanceEnvironment(env, platform = process.platform) {
  const refuse = (reason, keys) => { throw new AcceptanceRefusal(reason, keys); };
  if (platform !== 'linux') refuse('platform_not_linux');
  if (env.CI !== 'true') refuse('ci_required');
  if (env.GITHUB_ACTIONS !== 'true') refuse('github_actions_required');
  if (env.DOCKER_HERMES_BROWSER !== '1') refuse('explicit_optin_required');
  if (env.ACCEPTANCE_APP_SHA !== ACCEPTED_APP_SHA) refuse('app_sha_not_accepted');
  if (!/^[a-f0-9]{40}$/.test(env.ACCEPTANCE_HARNESS_SHA ?? '')) refuse('harness_sha_invalid');
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) refuse('run_identity_invalid');
  if (!/^\d+$/.test(env.DISPOSABLE_PG_PORT ?? '')) refuse('service_port_invalid');
  const pgKeys = Object.entries(env).filter(([key, value]) => /^PG/i.test(key) && value !== undefined).map(([key]) => key);
  if (pgKeys.length) refuse('pg_environment_override', pgKeys);
  // No inherited provider, identity, storage or broker configuration may affect the fixture.
  const forbidden = /^(OPENAI_|ANTHROPIC_|OPENROUTER_|AZURE_|AWS_|GOOGLE_|AUTH_MICROSOFT_|LDAP_|ENTRA_|SANDBOX_|LOCAL_HERMES_|DOCKER_HERMES_SOCKET$|ENCRYPTION_|TOOL_APPROVAL_SECRET$|AUTH_SECRET$|AUTH_URL$|NODE_OPTIONS$)/;
  const ambientKeys = Object.entries(env).filter(([key, value]) => forbidden.test(key) && value).map(([key]) => key);
  if (ambientKeys.length) refuse('ambient_configuration', ambientKeys);
  if (typeof env.DATABASE_URL !== 'string') refuse('database_url_invalid');
  if (/[?#]/.test(env.DATABASE_URL)) refuse('database_url_suffix');
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { refuse('database_url_invalid'); }
  if (url.protocol !== 'postgres:') refuse('database_scheme');
  if (url.hostname !== '127.0.0.1') refuse('database_host');
  if (url.port !== env.DISPOSABLE_PG_PORT || Number(url.port) < 1024 || Number(url.port) > 65535) refuse('database_port');
  if (url.pathname !== '/collective_docker_hermes_test') refuse('database_name');
  if (url.username !== 'postgres') refuse('database_user');
  if (url.password !== `fixture-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`) refuse('database_password');
  return { databaseUrl: url.href, appSha: ACCEPTED_APP_SHA, harnessSha: env.ACCEPTANCE_HARNESS_SHA };
}
