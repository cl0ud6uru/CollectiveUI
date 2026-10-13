export function siwcChildCommand(token: string): string;
export function siwcToolCommand(token: string, appServerPid: number, socketPath?: string): string;
export function passedSiwcChild(value: unknown, token: string, parentPid: number): boolean;
export function siwcToolEvidence(reply: unknown, token: string): { passed: boolean; checks: Record<string, boolean>; observed: Record<string, unknown> };
export function siwcAppServerObservation(token: string): string;
export function passedSiwcAppServerObservation(value: unknown, present: boolean, previousPid?: number): boolean;
export function siwcSocketPositiveControl(): string;
