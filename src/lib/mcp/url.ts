import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "@/lib/agent/tools/web";

type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/** Link-local (incl. the 169.254.169.254 metadata service), unspecified, multicast and other cloud metadata addresses. */
export function isBlockedAddress(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || (a === 169 && b === 254) || a >= 224 || host === "100.100.100.200";
  }
  if (isIP(host) !== 6 || host.includes("%")) return true;
  // URL parsing canonicalizes dotted mapped addresses to hex. Normalize expanded forms too, then check
  // the actual IPv4 address rather than treating its two hex words as an unrelated IPv6 address.
  const v = new URL(`http://[${host}]/`).hostname.slice(1, -1).toLowerCase();
  if (v.startsWith("::ffff:")) {
    const words = v.slice(7).split(":").map(h => parseInt(h, 16));
    return words.length !== 2 || isBlockedAddress(`${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`);
  }
  return v === "::" || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff") || v === "fd00:ec2::254";
}

/**
 * Checks an MCP server URL before the portal connects to it. Internal addresses are allowed (that's where company
 * MCP apps live, and only admins add servers), but not link-local or metadata addresses, credentials in the URL,
 * or cleartext http to a public host (the bearer key and identity token would cross the internet unencrypted).
 * Returns the problem, or null when the URL is fine. A host that doesn't resolve is left to the connection test.
 */
export async function checkMcpUrl(raw: string, lookup: Lookup = defaultLookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Only http(s) MCP servers can be added (stdio servers need an HTTP bridge)";
  if (url.username || url.password) return "Put credentials in a header, not in the URL";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host)).map((a) => a.address);
  } catch {
    return null;
  }
  if (addresses.some(isBlockedAddress)) return "Link-local and cloud metadata addresses are blocked";
  if (url.protocol === "http:" && addresses.some((a) => !isPrivateAddress(a)))
    return "Use https for a server outside your network (its key and the identity token would travel in cleartext)";
  return null;
}
