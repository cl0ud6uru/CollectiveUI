import { HttpError } from '@/lib/http-error';

/** Fixed categories only: never copy an exception message, payload or identifier. */
export function queueRejectionDiagnostic(error: unknown): {
  outcome: 'rejected';
  reason: 'native-busy' | 'unsupported' | 'http-error' | 'unexpected-rejection';
  status?: number;
} {
  if (!(error instanceof HttpError) || !Number.isInteger(error.status) || error.status < 400 || error.status > 599) {
    return { outcome: 'rejected', reason: 'unexpected-rejection' };
  }
  const reason = error.status === 409 && error.message === 'This native session has unfinished work.'
    ? 'native-busy'
    : error.status === 501 && error.message === 'This Hermes version does not support that feature.'
      ? 'unsupported'
      : 'http-error';
  return { outcome: 'rejected', reason, status: error.status };
}
