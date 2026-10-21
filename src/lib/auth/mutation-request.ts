import { HttpError } from "@/lib/http-error";
import { hasBearer } from "@/lib/public-routes";
import { assertAuthOrigin } from "./origin";

/** Call after requirePrincipal(): only an authenticated native token may omit the browser Origin check. */
export function assertMutationRequest(request: Request, contentType: "application/json" | "multipart/form-data" = "application/json") {
  if (!hasBearer(request.headers.get("authorization"))) assertAuthOrigin(request.headers);
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== contentType)
    throw new HttpError(415, contentType === "application/json" ? "JSON required" : "Multipart form data required");
}
