import React from 'react';
import type { HermesCommandCatalog } from '@/lib/chat/hermes-commands';

export function SessionYoloStatus({ state }: { state: HermesCommandCatalog['yolo'] }) {
  return <div role="status" data-testid="session-yolo-status" className="mb-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
    {state?.available
      ? `YOLO ${state.enabled ? 'ON — tool approvals bypassed' : 'OFF — normal tool approvals'} · session only · last verified by Hermes. /yolo status to recheck.`
      : `YOLO unverified · ${state && !state.available ? state.reason : 'Checking remote session approval mode…'} No approval state is assumed.`}
  </div>;
}
