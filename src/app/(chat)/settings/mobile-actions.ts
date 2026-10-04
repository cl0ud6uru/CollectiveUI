"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { revokeMobileSession } from "@/lib/auth/mobile";
import { requirePrincipal } from "@/lib/session";

/** Signs one of the person's devices out (or all of them without an id). */
export async function revokeMobileDevice(id?: string) {
  const p = await requirePrincipal();
  const deviceId = id === undefined ? undefined : z.string().min(1).max(64).parse(id);
  await revokeMobileSession(p.user.id, deviceId);
  await audit(p.user.id, "mobile.revoke", p.user.id, { device: deviceId ?? "all" });
  revalidatePath("/settings");
}
