export const MASK_STATES: string[];
export const CASE_CHECKS: string[];
export function passedProbe(reply: unknown, name: string): boolean;
export function allMaskChecksPass(cases: Record<string, Record<string, boolean>>): boolean;
export function maskCommands(state: string): Record<string, string>;
