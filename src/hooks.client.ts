import type { HandleClientError } from '@sveltejs/kit/hooks';
import { captureDiagnostic } from './lib/platform/diagnostics';

export const handleError: HandleClientError = ({ error, kind }) => {
  try {
    const record = captureDiagnostic(
      error,
      kind === 'unknown' ? 500 : error.status,
    );
    return {
      status: record.status,
      message: `The notes view encountered an error. Reference ${record.reference}.`,
    };
  } catch {
    return { status: 500, message: 'The notes view encountered an error.' };
  }
};
