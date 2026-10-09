import { readFileSync } from "node:fs";
import { Client, type Entry } from "ldapts";
import { sha256Hex } from "@/lib/crypto";

/**
 * On-prem Active Directory authentication over LDAP(S).
 *
 * Flow: bind as a service account → find the user → re-bind as the user to verify the
 * password → resolve group membership (nested groups via LDAP_MATCHING_RULE_IN_CHAIN on AD).
 */

export type LdapUser = {
  dn: string;
  identity?: string;
  upn: string;
  name: string;
  email?: string;
  groups: { dn: string; name?: string }[];
};

export type LdapConfig = {
  url: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  groupBaseDn: string;
  userFilter: string;
  upnSuffix?: string;
  groupMode: "ad" | "member" | "memberOf";
  rejectUnauthorized: boolean;
  caCertPath?: string;
  timeoutMs: number;
};

export { ldapEnabled } from "./config";

/** Connection, TLS, CA file, service-bind or search failure: the directory is the problem, not the user's password. */
export class LdapUnavailableError extends Error {
  constructor(cause: unknown) { super("LDAP directory unavailable", { cause }); this.name = "LdapUnavailableError"; }
}

async function directory<T>(work: () => T | Promise<T>): Promise<T> {
  try { return await work(); } catch (err) { throw err instanceof LdapUnavailableError ? err : new LdapUnavailableError(err); }
}

export function ldapConfigFromEnv(): LdapConfig {
  return {
    url: process.env.LDAP_URL ?? "",
    bindDn: process.env.LDAP_BIND_DN ?? "",
    bindPassword: process.env.LDAP_BIND_PASSWORD ?? "",
    baseDn: process.env.LDAP_BASE_DN ?? "",
    groupBaseDn: process.env.LDAP_GROUP_BASE_DN ?? process.env.LDAP_BASE_DN ?? "",
    userFilter:
      process.env.LDAP_USER_FILTER ??
      "(&(objectClass=user)(|(sAMAccountName={{username}})(userPrincipalName={{username}})))",
    upnSuffix: process.env.LDAP_UPN_SUFFIX,
    groupMode: (process.env.LDAP_GROUP_MODE as LdapConfig["groupMode"]) ?? "ad",
    rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== "false",
    caCertPath: process.env.LDAP_CA_CERT,
    timeoutMs: Number(process.env.LDAP_TIMEOUT_MS ?? 8000),
  };
}

/** RFC 4515 filter value escaping. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => "\\" + c.charCodeAt(0).toString(16).padStart(2, "0"));
}

/** Normalise "DOMAIN\\user", "user@domain" and "user" into the lookup value. */
export function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  const backslash = trimmed.indexOf("\\");
  return backslash >= 0 ? trimmed.slice(backslash + 1) : trimmed;
}

/** Extract the CN from a DN, e.g. "CN=AI Users,OU=Groups,DC=corp" → "AI Users". */
export function cnFromDn(dn: string): string | undefined {
  const m = /^cn=((?:\\.|[^,])+)/i.exec(dn);
  return m ? m[1].replace(/\\(.)/g, "$1") : undefined;
}

function first(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return v == null || v === "" ? undefined : String(v);
}

function all(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return v == null || v === "" ? [] : [String(v)];
}

function newClient(cfg: LdapConfig) {
  return new Client({
    url: cfg.url,
    timeout: cfg.timeoutMs,
    connectTimeout: cfg.timeoutMs,
    tlsOptions: cfg.url.startsWith("ldaps")
      ? {
          rejectUnauthorized: cfg.rejectUnauthorized,
          ca: cfg.caCertPath ? [readFileSync(cfg.caCertPath)] : undefined,
        }
      : undefined,
  });
}

export async function authenticateLdap(
  usernameInput: string,
  password: string,
  cfg: LdapConfig = ldapConfigFromEnv(),
  allowIdentity?: (dn: string) => Promise<boolean>,
): Promise<LdapUser | null> {
  const username = normalizeUsername(usernameInput);
  // An empty password would be an "unauthenticated bind" that many servers accept — always reject.
  if (!username || !password) return null;

  const service = await directory(() => newClient(cfg));
  try {
    await directory(() => service.bind(cfg.bindDn, cfg.bindPassword));
    const filter = cfg.userFilter.replaceAll("{{username}}", escapeFilterValue(username));
    const { searchEntries } = await directory(() => service.search(cfg.baseDn, {
      scope: "sub",
      filter,
      sizeLimit: 2,
      attributes: identityAttributes,
      explicitBufferAttributes: ["objectGUID"],
    }));
    if (searchEntries.length !== 1) return null;
    let entry = searchEntries[0];
    if (allowIdentity && !await allowIdentity(entry.dn)) return null;

    // Verify the password with a bind as the user.
    const userClient = newClient(cfg);
    try {
      await userClient.bind(entry.dn, password);
    } catch {
      return null;
    } finally {
      await userClient.unbind().catch(() => {});
    }

    // Read AD constructed account status at the entry itself, including in memberOf mode.
    if (cfg.groupMode === "ad" || hasAdGuid(entry)) {
      const status = await directory(() => service.search(entry.dn, { scope: "base", filter: "(objectClass=*)", sizeLimit: 2,
        attributes: identityAttributes, explicitBufferAttributes: ["objectGUID"] }));
      if (status.searchEntries.length !== 1) return null;
      entry = status.searchEntries[0];
    }
    if (!ldapAccountActive(entry, cfg)) return null;
    return await directory(() => resolveEntry(service, entry, username, cfg));
  } finally {
    await service.unbind().catch(() => {});
  }
}

const identityAttributes = ["dn", "userPrincipalName", "sAMAccountName", "uid", "mail", "displayName", "cn", "memberOf",
  "objectGUID", "entryUUID", "userAccountControl", "msDS-User-Account-Control-Computed", "accountExpires", "pwdAccountLockedTime", "pwdStartTime", "pwdEndTime"];

function hasAdGuid(entry: Entry) {
  const value = Array.isArray(entry.objectGUID) ? entry.objectGUID[0] : entry.objectGUID;
  return Buffer.isBuffer(value) && value.length === 16;
}

/** Stable identity prevents a deleted/recreated DN from inheriting an old passkey. */
export function ldapEntryIdentity(entry: Entry, cfg: LdapConfig): string | undefined {
  const guid = Array.isArray(entry.objectGUID) ? entry.objectGUID[0] : entry.objectGUID;
  const id = Buffer.isBuffer(guid) && guid.length === 16 ? `ad:${guid.toString("hex")}` : first(entry.entryUUID);
  return id ? sha256Hex(JSON.stringify([cfg.url, cfg.baseDn.toLowerCase(), id])) : undefined;
}

export function ldapAccountActive(entry: Entry, cfg: LdapConfig, now = Date.now()): boolean {
  const flags = first(entry.userAccountControl), computed = first(entry["msDS-User-Account-Control-Computed"]);
  // AD status must be readable; an unreadable disabled flag cannot become an allow.
  if ((cfg.groupMode === "ad" || hasAdGuid(entry)) && (!flags || !computed)) return false;
  for (const value of [flags, computed]) {
    if (value !== undefined && (!/^\d{1,10}$/.test(value) || Number(value) > 4294967295 || (Number(value) & (2 | 16)) !== 0)) return false;
  }
  const expires = first(entry.accountExpires);
  if (expires !== undefined) {
    if (!/^\d+$/.test(expires)) return false;
    const ticks = BigInt(expires);
    if (ticks !== BigInt(0) && ticks !== BigInt("9223372036854775807") && ticks <= (BigInt(now) + BigInt("11644473600000")) * BigInt(10000)) return false;
  }
  // Conservatively deny ppolicy locks until the directory clears them.
  if (first(entry.pwdAccountLockedTime)) return false;
  for (const [attribute, before] of [["pwdStartTime", true], ["pwdEndTime", false]] as const) {
    const value = first(entry[attribute]);
    if (!value) continue;
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(value);
    if (!match) return false;
    const time = Date.UTC(...[Number(match[1]), Number(match[2]) - 1, ...match.slice(3).map(Number)] as [number, number, number, number, number, number]);
    if (before ? now < time : now >= time) return false;
  }
  return true;
}

async function resolveEntry(service: Client, entry: Entry, username: string, cfg: LdapConfig): Promise<LdapUser> {
  const account = first(entry.sAMAccountName) ?? first(entry.uid) ?? username;
  let upn = first(entry.userPrincipalName);
  if (!upn) upn = username.includes("@") ? username : `${account}${cfg.upnSuffix ? "@" + cfg.upnSuffix : ""}`;

  let groupDns: string[] = [];
  if (cfg.groupMode === "memberOf") {
    groupDns = all(entry.memberOf);
  } else {
    const groupFilter =
      cfg.groupMode === "ad"
        ? `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:=${escapeFilterValue(entry.dn)}))`
        : `(|(member=${escapeFilterValue(entry.dn)})(uniqueMember=${escapeFilterValue(entry.dn)}))`;
    const res = await service.search(cfg.groupBaseDn, { scope: "sub", filter: groupFilter, attributes: ["dn", "cn"] });
    groupDns = res.searchEntries.map((g) => g.dn);
  }

  return {
    dn: entry.dn,
    identity: ldapEntryIdentity(entry, cfg),
    upn: upn.toLowerCase(),
    name: first(entry.displayName) ?? first(entry.cn) ?? account,
    email: first(entry.mail),
    groups: groupDns.map((dn) => ({ dn: dn.toLowerCase(), name: cnFromDn(dn) })),
  };
}

/** Service-account lookup only; never store or reuse a user's directory password. */
export async function readLdapIdentity(dn: string, identity: string, cfg = ldapConfigFromEnv()): Promise<LdapUser | null> {
  const service = newClient(cfg);
  try {
    await service.bind(cfg.bindDn, cfg.bindPassword);
    const { searchEntries } = await service.search(dn, { scope: "base", filter: "(objectClass=*)", sizeLimit: 2,
      attributes: identityAttributes, explicitBufferAttributes: ["objectGUID"] });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];
    if (ldapEntryIdentity(entry, cfg) !== identity || !ldapAccountActive(entry, cfg)) return null;
    return await resolveEntry(service, entry, "", cfg);
  } finally { await service.unbind().catch(() => {}); }
}

/** Recovery/enrollment still proves the actual company password against the bound entry. */
export async function authenticateLdapAtBinding(dn: string, identity: string, password: string, cfg = ldapConfigFromEnv()) {
  if (!password) return null;
  const user = await readLdapIdentity(dn, identity, cfg);
  if (!user) return null;
  const client = newClient(cfg);
  try { await client.bind(dn, password); return user; }
  catch { return null; }
  finally { await client.unbind().catch(() => {}); }
}
