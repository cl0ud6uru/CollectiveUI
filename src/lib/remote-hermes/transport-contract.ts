/** Private-address approval permits routing; it cannot establish transport encryption. */
export function dashboardTransportDisclosure(base: string): string | null {
  let url: URL;
  try { url = new URL(base); } catch { return null; }
  return url.protocol === 'http:'
    ? 'HTTP is not encrypted. Administrator approval permits access but does not encrypt it. Without a separately verified encrypted tunnel, passwords, tokens and protected replies can be exposed. Use HTTPS when available.'
    : null;
}
