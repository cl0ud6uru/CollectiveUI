import { z } from "zod";

/** One file per /api/files request; keep multipart overhead below Next's bounded proxy buffer. */
export const MAX_UPLOAD_MB = 25;
export const MAX_UPLOAD_BODY_MB = 30;
export const DEFAULT_UPLOAD_MB = 20;
export const uploadMaxMbInput = z.number().int().min(1).max(MAX_UPLOAD_MB, `Files can be at most ${MAX_UPLOAD_MB} MB.`);

/** Preserve legacy saved limits for review, but never advertise/enforce more than the transport supports. */
export function effectiveUploadMaxMb(configured: number): number {
  return Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), MAX_UPLOAD_MB) : DEFAULT_UPLOAD_MB;
}
