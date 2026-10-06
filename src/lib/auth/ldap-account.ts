import { authenticateLdap, normalizeUsername } from "./ldap";
import { ldapEnabled } from "./config";
import { allowPasswordAttempt, allowAccountAttempt } from "./throttle";
import { syncUserOnSignIn } from "./groups";

/** Password verification for both unprotected sign-in and protected recovery. */
export async function authenticateLdapPassword(username: string, password: string, headers: Headers) {
  if (!ldapEnabled() || username.length > 254 || password.length > 512 ||
    !await allowPasswordAttempt("ldap", normalizeUsername(username).toLowerCase(), headers)) return null;
  const identity = await authenticateLdap(username, password, undefined, dn => allowAccountAttempt("ldap-dn", dn.toLowerCase()));
  if (!identity) return null;
  const user = await syncUserOnSignIn({ ...identity, source: "ldap", groups: identity.groups.map(g => ({ externalId: g.dn, displayName: g.name })) });
  return user.disabled ? null : { user, identity };
}
