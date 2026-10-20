import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http-error';
import { queueRejectionDiagnostic } from '../fixtures/remote-hermes-queue-diagnostics';

describe('native queue fixture diagnostics', () => {
  it('classifies only known application-owned busy and unsupported guidance', () => {
    expect(queueRejectionDiagnostic(new HttpError(409, 'This native session has unfinished work.'))).toEqual({ outcome: 'rejected', reason: 'native-busy', status: 409 });
    expect(queueRejectionDiagnostic(new HttpError(501, 'This Hermes version does not support that feature.'))).toEqual({ outcome: 'rejected', reason: 'unsupported', status: 501 });
  });

  it.each([409, 501, 502])('retains only a valid local HttpError status %i from arbitrary messages', status => {
    const secret = 'credential-secret https://private.invalid/session/private-session';
    const error = Object.assign(new HttpError(status, secret), { payload: secret, code: secret });
    const diagnostic = queueRejectionDiagnostic(error);
    expect(diagnostic).toEqual({ outcome: 'rejected', reason: 'http-error', status });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  it.each([
    new Error('credential-secret https://private.invalid/private-session'),
    { status: 409, message: 'This native session has unfinished work.', payload: 'credential-secret' },
    new HttpError(999, 'credential-secret'),
    new HttpError(NaN, 'credential-secret'),
    new HttpError(409.5, 'credential-secret'),
    null,
    'credential-secret',
  ])('does not trust rejected values or invalid HTTP statuses (%#)', error => {
    expect(queueRejectionDiagnostic(error)).toEqual({ outcome: 'rejected', reason: 'unexpected-rejection' });
  });
});
