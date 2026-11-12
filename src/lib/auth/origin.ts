import { HttpError } from "@/lib/http-error";

/** Cookie-authenticated mutations require the configured public HTTP(S) origin, never request/forwarded hosts. */
export function assertAuthOrigin(headers: Headers) {
  let expected: string | undefined;
  try {
    const url = new URL(process.env.AUTH_URL ?? "");
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
      expected = url.origin;
  } catch { /* An absent or invalid public URL must fail closed with the same response. */ }
  if (!expected || headers.get("origin") !== expected || headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "Invalid request origin");
}
