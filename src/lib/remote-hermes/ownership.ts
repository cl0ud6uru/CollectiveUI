/** Cross-process socket ownership contracts. PostgreSQL leases elect a portal owner; only the
 * versioned native fence proves that an obsolete WebSocket cannot act after takeover. */
export const PORTAL_HUB_OWNERSHIP_PROTOCOL = 'collective.portal-hub-ownership.v1' as const;
export const NATIVE_HUB_OWNER_PROTOCOL = 'collective.native-hub-owner.v1' as const;
export const HUB_OWNER_LEASE_MS = 30_000;

export type NativeHubFence = {
  protocol: typeof NATIVE_HUB_OWNER_PROTOCOL;
  /** Portal lease tuple echoed by native claim. */
  generation: number;
  socketEpoch: number;
  /** Durable, profile-scoped CAS epoch allocated by the native gateway. */
  nativeGeneration: number;
  phase: 'full' | 'recovery';
  recoveryId: string | null;
  recoverySessionId: string | null;
  recoveryStoredSessionId: string | null;
};

export type RemoteHubOwnershipSnapshot = Readonly<{
  protocol: typeof PORTAL_HUB_OWNERSHIP_PROTOCOL;
  ownerId: string;
  connectionId: string;
  instanceId: string;
  leaseGeneration: number;
  sessionId: string;
  profile: string;
  storedId: string;
  runtimeId: string | null;
  sessionRevision: number;
  ownershipGeneration: number;
  socketEpoch: number;
  portalSocketEpoch: number;
  nativeFence: NativeHubFence | null;
}>;
