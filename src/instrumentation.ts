export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.AGENT_BROWSER_ENABLED === "1") {
      const { registerAgentBrowserViewerIntegration } = await import("@/lib/agent-browser/integration");
      await registerAgentBrowserViewerIntegration();
    }
    const { warnAboutVendorEnv } = await import("@/lib/env-guard");
    warnAboutVendorEnv("web");
    const { entraEnabled, ldapEnabled, localEnabled } = await import("@/lib/auth/config");
    // The stack still reports healthy without one, so make the reason nobody can sign in obvious in the logs.
    if (!entraEnabled() && !ldapEnabled() && !localEnabled())
      console.warn("[web] no sign-in method is enabled: set AUTH_LOCAL_ENABLED=true, LDAP_ENABLED=true (with LDAP_URL) or configure Microsoft Entra in .env");
  }
}
