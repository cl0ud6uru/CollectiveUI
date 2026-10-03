import { errorResponse } from "@/lib/session";
export const PET_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export const petJson = (value: unknown) => Response.json(value, { headers: PET_HEADERS });
export const petImage = (sprite: Buffer) => new Response(new Uint8Array(sprite), { headers: {
  ...PET_HEADERS, "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
} });

/** Failures must not leave a cacheable 404/403 after publication or account changes. */
export function petError(error: unknown) {
  const response = errorResponse(error);
  for (const [key, value] of Object.entries(PET_HEADERS)) response.headers.set(key, value);
  return response;
}
