import { errorResponse } from "@/lib/session";
export const PET_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export const petJson = (value: unknown) => Response.json(value, { headers: PET_HEADERS });
/** Normalized v2 sheets are PNG; HD renditions are WebP. Both were re-encoded by the server before storage. */
export const petImageType = (sprite: Buffer) => sprite.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : "image/png";
export const petImage = (sprite: Buffer) => new Response(new Uint8Array(sprite), { headers: {
  ...PET_HEADERS, "Content-Type": petImageType(sprite), "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
} });

/** Failures must not leave a cacheable 404/403 after publication or account changes. */
export function petError(error: unknown) {
  const response = errorResponse(error);
  for (const [key, value] of Object.entries(PET_HEADERS)) response.headers.set(key, value);
  return response;
}
