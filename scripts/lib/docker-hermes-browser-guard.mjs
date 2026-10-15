/** CI-only browser acceptance boundary. No application or PostgreSQL imports belong in this module. */
export const ACCEPTED_APP_SHA = 'a3d689253aa7a68ed30dbf21acfbe8f244120531';
export const EXPECTED_BROWSER_CASES = 10;
export function browserAcceptanceEnvironment(env, platform = process.platform) {
  const refuse = () => { throw new Error('Disposable Docker Hermes browser environment refused.'); };
  if (platform !== 'linux' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.DOCKER_HERMES_BROWSER !== '1') refuse();
  if (env.ACCEPTANCE_APP_SHA !== ACCEPTED_APP_SHA || !/^[a-f0-9]{40}$/.test(env.ACCEPTANCE_HARNESS_SHA ?? '')) refuse();
  if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') || !/^\d+$/.test(env.DISPOSABLE_PG_PORT ?? '')) refuse();
  if (Object.entries(env).some(([key, value]) => /^PG/i.test(key) && value !== undefined)) refuse();
  // No inherited provider, identity, storage or broker configuration may affect the fixture.
  const forbidden = /^(OPENAI_|ANTHROPIC_|OPENROUTER_|AZURE_|AWS_|GOOGLE_|AUTH_MICROSOFT_|LDAP_|ENTRA_|SANDBOX_|LOCAL_HERMES_|DOCKER_HERMES_SOCKET$|ENCRYPTION_|TOOL_APPROVAL_SECRET$|AUTH_SECRET$|AUTH_URL$|NODE_OPTIONS$)/;
  if (Object.entries(env).some(([key, value]) => forbidden.test(key) && value)) refuse();
  if (typeof env.DATABASE_URL !== 'string' || /[?#]/.test(env.DATABASE_URL)) refuse();
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { refuse(); }
  if (url.protocol !== 'postgres:' || url.hostname !== '127.0.0.1' || url.port !== env.DISPOSABLE_PG_PORT || Number(url.port) < 1024 || Number(url.port) > 65535 ||
    url.pathname !== '/collective_docker_hermes_test' || url.username !== 'postgres' || url.password !== `fixture-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` || url.search || url.hash) refuse();
  return { databaseUrl: url.href, appSha: ACCEPTED_APP_SHA, harnessSha: env.ACCEPTANCE_HARNESS_SHA };
}
