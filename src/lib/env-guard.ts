/**
 * AI SDK providers silently fall back to these variables when a setting is not passed as a string. The portal
 * always passes credentials and endpoints explicitly (org keys from the DB, user keys from the credential store),
 * so a stray variable could bill the wrong account. We warn at start-up instead of failing, to keep existing
 * installs running. src/lib/llm/providers/* is written so that none of these is ever read.
 */
export const VENDOR_FALLBACK_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AZURE_API_KEY",
  "AZURE_RESOURCE_NAME",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "GOOGLE_VERTEX_PROJECT",
  "GOOGLE_VERTEX_LOCATION",
  "GOOGLE_VERTEX_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLIENT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
  "GOOGLE_PRIVATE_KEY_ID",
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
];

/**
 * Also read by the SDKs, but set automatically on cloud hosts (e.g. AWS_REGION on ECS/Lambda), so warning about
 * them would be noise. Tests still prove they are never used (tests/unit/providers.test.ts).
 */
export const QUIET_FALLBACK_ENV = ["AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"];

export function vendorEnvPresent(env: Record<string, string | undefined> = process.env): string[] {
  return VENDOR_FALLBACK_ENV.filter((k) => !!env[k]);
}

/** Test/dev-mock endpoint overrides for Sign in with ChatGPT; ignored in production (src/lib/llm/chatgpt/constants.ts). */
export const DEV_ONLY_ENV = ["CHATGPT_AUTH_BASE_URL", "CHATGPT_BACKEND_URL"];

export function warnAboutVendorEnv(where: string) {
  const found = vendorEnvPresent();
  if (found.length)
    console.warn(`[${where}] ignoring vendor credential variables (configure credentials in the admin panel instead): ${found.join(", ")}`);
  const devOnly = DEV_ONLY_ENV.filter((k) => !!process.env[k]);
  if (devOnly.length && process.env.NODE_ENV === "production") console.warn(`[${where}] ignoring test-only variables in production: ${devOnly.join(", ")}`);
}
