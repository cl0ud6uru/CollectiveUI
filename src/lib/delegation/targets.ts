import { db, type DbOrTx } from "@/db";
import type { Principal } from "@/lib/auth/groups";
import { assertPersistedDelegationEdge } from "@/lib/coordinator/delegation";
import type { DelegationEdge, DelegationSource } from "./source";

/** Discovery is not a grant: durable admission and execution share the current coordinator/manual policy. */
export async function assertDelegationEdge(principal: Principal, edge: DelegationEdge, source: DelegationSource, q: DbOrTx = db, nativeOnly = false): Promise<void> {
  await assertPersistedDelegationEdge(principal, edge, source, nativeOnly, q);
}
