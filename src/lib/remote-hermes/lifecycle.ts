/** Local eager invalidation is an optimization; database checks fence other processes. */
const globalLifecycle = globalThis as unknown as { collectiveRemoteHermesRetirements?: Map<string, () => void> };
const retirements = globalLifecycle.collectiveRemoteHermesRetirements ??= new Map();
export function registerNativeConnection(ownerId: string, connectionId: string, retire: () => void) {
  const key = `${ownerId}:${connectionId}`;
  retirements.set(key, retire);
  return () => { if (retirements.get(key) === retire) retirements.delete(key); };
}
export function retireNativeConnection(ownerId: string, connectionId: string) {
  retirements.get(`${ownerId}:${connectionId}`)?.();
}
