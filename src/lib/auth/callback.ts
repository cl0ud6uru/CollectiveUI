/** Keep redirects within this installation, including the already-signed-in login path. */
export function safeCallback(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) return "/";
  return value;
}
