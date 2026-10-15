/** Validate before importing any database-backed code or constructing its pool. */
export function assertDisposableHermesDatabase(raw: string | undefined) {
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new Error('Named disposable loopback hermes_fixture database required'); }
  // pg-connection-string lets query parameters override host/database/credentials.
  // This fixture needs no connection-string query option, so reject the entire surface.
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || url.pathname !== '/hermes_fixture' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('Named disposable loopback hermes_fixture database without connection overrides required');
  }
}
