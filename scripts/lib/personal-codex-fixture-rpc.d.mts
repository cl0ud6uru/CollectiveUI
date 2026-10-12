import type { ChildProcessWithoutNullStreams } from 'node:child_process';
export type FixtureSnapshot = { processClosed: boolean; processExitCode: number | null; processSignal: string | null; startupStderr: string; transportDiagnostic: string };
export function redactFixtureText(value: unknown): string;
export const FIXTURE_REDACTION_RULES: { source: string; flags: string; replacement: string }[];
export function fixtureRpc(child: ChildProcessWithoutNullStreams, options?: { timeoutMs?: number }): {
  request(method: string, params: unknown): Promise<{ result?: unknown; error?: { message: string } }>;
  notify(method: string, params?: unknown): boolean;
  snapshot(): FixtureSnapshot;
};
export function fixtureFailure(error: unknown, stage: string, context?: Partial<FixtureSnapshot>): {
  stage: string; reason: string; operationExitCode: number | null; diagnostic: string;
} & Partial<FixtureSnapshot>;
