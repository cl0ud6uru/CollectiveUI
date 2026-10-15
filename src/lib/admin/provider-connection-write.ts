import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { providerConnections } from "@/db/schema";
import type { ProviderConnection } from "@/lib/llm/provider-connections";
import { HttpError } from "@/lib/authz";

/** PostgreSQL timestamps retain microseconds; JavaScript Date only keeps milliseconds. */
export const providerConnectionUpdatedAtToken = sql<string>`to_char(${providerConnections.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function readProviderConnectionUpdatedAtToken(tx: Tx, id: string) {
  const [row] = await tx.select({ token: providerConnectionUpdatedAtToken }).from(providerConnections).where(eq(providerConnections.id, id));
  if (!row) throw new HttpError(404, "Provider connection not found.");
  return row.token;
}

/** Shared metadata-only compare-and-swap used by Admin and The Architect. Credentials and destinations stay separate. */
export async function updateProviderConnectionMetadata(
  tx: Tx,
  current: ProviderConnection,
  patch: { name: string; enabled: boolean },
  expectedUpdatedAt?: string,
) {
  const token = await readProviderConnectionUpdatedAtToken(tx, current.id);
  if (expectedUpdatedAt !== undefined && token !== expectedUpdatedAt)
    throw new HttpError(409, "Provider connection changed. Read it again and request fresh approval.");
  const updatedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
  const [saved] = await tx.update(providerConnections).set({ name: patch.name, enabled: patch.enabled, updatedAt })
    .where(sql`${providerConnections.id} = ${current.id} and ${providerConnections.updatedAt} = ${token}::timestamptz`).returning();
  if (!saved) throw new HttpError(409, "Provider connection changed. Read it again and request fresh approval.");
  return saved;
}
