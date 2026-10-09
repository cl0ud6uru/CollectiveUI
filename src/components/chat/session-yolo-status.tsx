import React from 'react';
import type { HermesCommandCatalog } from '@/lib/chat/hermes-commands';

export function SessionYoloStatus({ state }: { state: HermesCommandCatalog['yolo'] }) {
  const local = state?.available && state.verifier === 'local-controller';
  return <div role="status" data-testid="session-yolo-status" className="mb-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
    {state?.available
      ? `YOLO ${state.enabled ? (local ? 'ON — eligible tool approvals auto-approved once' : 'ON — tool approvals bypassed') : (local ? 'OFF — native approval policy applies' : 'OFF — normal tool approvals')} · session only · last verified by ${local ? 'the local controller' : 'Hermes'}. /yolo status to recheck.`
      : `YOLO unverified · ${state && !state.available ? state.reason : 'Checking session approval mode…'} No approval state is assumed.`}
  </div>;
}
