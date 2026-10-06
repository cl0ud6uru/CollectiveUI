/** Provider switches are server/operator configuration, never database settings or browser input. */
export const mobileEnabled = () => process.env.MOBILE_APP_ENABLED === "true";
export const localEnabled = () => process.env.AUTH_LOCAL_ENABLED === "true";
export const entraEnabled = () => process.env.AUTH_ENTRA_ENABLED !== "false" && !!process.env.AUTH_MICROSOFT_ENTRA_ID_ID;
export const ldapEnabled = () => process.env.LDAP_ENABLED === "true" && !!process.env.LDAP_URL;
export function providerEnabled(provider: string) {
  return provider === "local" ? localEnabled() : provider === "ldap" ? ldapEnabled() : provider === "microsoft-entra-id" ? entraEnabled() : false;
}
