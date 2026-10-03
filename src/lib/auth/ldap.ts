import { readFileSync } from "node:fs";
import { Client } from "ldapts";

/**
 * On-prem Active Directory authentication over LDAP(S).
 *
 * Flow: bind as a service account → find the user → re-bind as the user to verify the
 * password → resolve group membership (nested groups via LDAP_MATCHING_RULE_IN_CHAIN on AD).
 */

export type LdapUser = {
  dn: string;
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

  const service = newClient(cfg);
  try {
    await service.bind(cfg.bindDn, cfg.bindPassword);
    const filter = cfg.userFilter.replaceAll("{{username}}", escapeFilterValue(username));
    const { searchEntries } = await service.search(cfg.baseDn, {
      scope: "sub",
      filter,
      sizeLimit: 2,
      attributes: ["dn", "userPrincipalName", "sAMAccountName", "uid", "mail", "displayName", "cn", "memberOf"],
    });
    if (searchEntries.length !== 1) return null;
    const entry = searchEntries[0];
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
      upn: upn.toLowerCase(),
      name: first(entry.displayName) ?? first(entry.cn) ?? account,
      email: first(entry.mail),
      groups: groupDns.map((dn) => ({ dn: dn.toLowerCase(), name: cnFromDn(dn) })),
    };
  } finally {
    await service.unbind().catch(() => {});
  }
}
