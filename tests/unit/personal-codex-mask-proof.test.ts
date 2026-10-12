import { describe, expect, it } from 'vitest';
import { allMaskChecksPass, CASE_CHECKS, MASK_STATES, maskCommands, passedProbe } from '../../scripts/lib/personal-codex-mask-proof.mjs';

const success = () => ({ result: { exitCode: 0, stdout: '{"probe":"homeReadDenied","passed":true}', stderr: '' } });

describe('credential-free protected-mask proof', () => {
  it('requires successful native execution with the exact expected marker', () => {
    expect(passedProbe(success(), 'homeReadDenied')).toBe(true);
    expect(passedProbe(success(), 'homeWriteDenied')).toBe(false);
  });
  it.each([
    {},
    { error: { message: 'RPC timed out' } },
    { result: { exitCode: 1, stdout: '', stderr: 'namespace failed' } },
    { result: { exitCode: 0, stdout: '', stderr: '' } },
    { result: { exitCode: 0, stdout: '{"probe":"homeReadDenied","passed":true,"extra":"sentinel"}', stderr: '' } },
    { result: { exitCode: 0, stdout: '{"probe":"homeReadDenied","passed":false}', stderr: '' } },
  ])('does not accept unavailable execution or malformed proof: %j', reply => {
    expect(passedProbe(reply, 'homeReadDenied')).toBe(false);
  });
  it('requires every named protection for all three metadata states', () => {
    const cases = Object.fromEntries(MASK_STATES.map(state => [state, Object.fromEntries(CASE_CHECKS.map(name => [name, true]))]));
    expect(allMaskChecksPass(cases)).toBe(true);
    cases.missing.unexpectedFailure = false;
    expect(allMaskChecksPass(cases)).toBe(false);
    delete cases.missing.unexpectedFailure;
    delete cases.populated.activeHelperExecution;
    expect(allMaskChecksPass(cases)).toBe(false);
    expect(allMaskChecksPass({})).toBe(false);
  });
  it('rejects truthy values and native diagnostics masquerading as proof', () => {
    const reply = success();
    reply.result.stderr = 'sandbox failed';
    expect(passedProbe(reply, 'homeReadDenied')).toBe(false);
    const invalid = Object.fromEntries(MASK_STATES.map(state => [state, Object.fromEntries(CASE_CHECKS.map(name => [name, 'yes']))]));
    expect(allMaskChecksPass(invalid as never)).toBe(false);
  });
  it('generates executable JavaScript for each native probe and rejects unrecognized states', () => {
    for (const state of MASK_STATES) for (const script of Object.values(maskCommands(state))) {
      expect(() => new Function(script)).not.toThrow();
    }
    expect(() => maskCommands('unknown')).toThrow();
  });
});
