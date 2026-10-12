export { MASK_STATES, passedProbe } from './personal-codex-mask-proof.mjs';
export const STOCK_CASE_CHECKS: string[];
export function allStockChecksPass(cases: Record<string, Record<string, boolean>>): boolean;
export function stockCommands(state: string): Record<string, string>;
export function networkCommand(denied?: boolean): string;
