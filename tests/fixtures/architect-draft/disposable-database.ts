/** Pure guard: call before importing pg, @/db, migrations or any application module. */
export function architectDraftFixtureURL(env: Record<string, string | undefined> = process.env): string {
  const failure = () => new Error('Explicit Architect draft proof opt-in and exact disposable loopback database required; connection overrides are forbidden');
  if (env.ARCHITECT_DRAFT_POSTGRES_PROOF !== '1') throw failure();
  const raw = env.ARCHITECT_DRAFT_POSTGRES_TEST_URL ?? '';
  let url: URL;
  try { url = new URL(raw); } catch { throw failure(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' ||
      url.pathname !== '/collective_architect_draft_proof_test' || url.username !== 'native_budget_fixture' ||
      url.password !== 'synthetic-fixture-only' || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535 || raw.includes('?') || raw.includes('#') || url.search || url.hash)
    throw failure();
  if (Object.keys(env).some(key => /^PG(?:HOST|HOSTADDR|PORT|DATABASE|USER|PASSWORD|OPTIONS|SERVICE|SERVICEFILE|SSLMODE|SSLROOTCERT|SSLCERT|SSLKEY|APPNAME|CONNECT_TIMEOUT|CLIENTENCODING)$/.test(key) && env[key])) throw failure();
  return url.href;
}
