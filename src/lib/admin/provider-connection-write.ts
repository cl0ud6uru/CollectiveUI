import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { providerConnections } from "@/db/schema";
import type { ProviderConnection } from "@/lib/llm/provider-connections";
import { HttpError } from "@/lib/authz";

/** Shared metadata-only compare-and-swap used by Admin and The Architect. Credentials and destinations stay separate. */
export async function updateProviderConnectionMetadata(
  tx: Tx,
  current: ProviderConnection,
  patch: { name: string; enabled: boolean },
  expectedUpdatedAt?: Date,
) {
  if (expectedUpdatedAt && current.updatedAt.getTime() !== expectedUpdatedAt.getTime())
    throw new HttpError(409, "Provider connection changed. Read it again and request fresh approval.");
  const updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
  const [saved] = await tx.update(providerConnections).set({ name: patch.name, enabled: patch.enabled, updatedAt })
    .where(and(eq(providerConnections.id, current.id), eq(providerConnections.updatedAt, current.updatedAt))).returning();
  if (!saved) throw new HttpError(409, "Provider connection changed. Read it again and request fresh approval.");
  return saved;
}
