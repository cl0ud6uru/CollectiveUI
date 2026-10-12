import { describe, expect, it } from 'vitest';
import { allStockChecksPass, MASK_STATES, networkCommand, STOCK_CASE_CHECKS, stockCommands } from '../../scripts/lib/personal-codex-stock-proof.mjs';

describe('stock native acceptance gate', () => {
  it('requires every protection, positive control and persistence check in every state', () => {
    const cases: Record<string, Record<string, boolean>> = Object.fromEntries(MASK_STATES.map(state =>
      [state, Object.fromEntries(STOCK_CASE_CHECKS.map(name => [name, true]))]));
    expect(allStockChecksPass(cases)).toBe(true);
    for (const name of ['nativeWorkspaceExecution', 'homeReadDenied', 'metadataProtected', 'processIsolation',
      'activeHelperExecution', 'shadowWriteIntegrity', 'backingDataUnchanged', 'networkControlReachable',
      'nativeNetworkDenied', 'replacementExecution']) {
      cases.empty[name] = false;
      expect(allStockChecksPass(cases)).toBe(false);
      cases.empty[name] = true;
    }
    delete cases.populated.stockArtifactsMatch;
    expect(allStockChecksPass(cases)).toBe(false);
    expect(allStockChecksPass({})).toBe(false);
  });
  it('generates valid fixture programs for all metadata states and both network controls', () => {
    for (const state of MASK_STATES) for (const script of Object.values(stockCommands(state))) {
      expect(() => new Function(script)).not.toThrow();
    }
    expect(() => new Function(networkCommand(false))).not.toThrow();
    expect(() => stockCommands('unrecognized')).toThrow();
  });
});
