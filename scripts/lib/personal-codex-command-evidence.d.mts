export const COMMAND_EVIDENCE_LIMIT: number;
export function commandEvidence(reply: unknown, expectedProbe: string): {
  passed: boolean;
  expected: { exitCode: number; stderr: string; proof: { probe: string; passed: boolean }; proofKeys: string[] };
  actual: Record<string, unknown>;
  mismatches: string[];
};
export function traceFixtureCommand(script: string, probe: string): string;
export function collectCommandEvidence(failures: Record<string, unknown[]>, state: string,
  context: { check: string; phase: string; commandSha256: string }, reply: unknown, expectedProbe?: string): boolean;
