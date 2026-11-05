import { NativeActionPreflight } from './native-action-preflight.js';
import type { NativeWorkSubmissionState } from './native-work-submission.js';
export class NativeWorkSubmissionPreflight extends NativeActionPreflight<NativeWorkSubmissionState> {
  constructor(identity: () => string, invalidate: () => void) {
    super(identity, invalidate, {
      releaseOnClose: false,
      busy: () => ({ status: 'pending', message: 'A native submission action is already in progress.' }),
      unavailable: () => ({ status: 'unavailable', message: 'Native submission workspace or host is unavailable.' }),
    });
  }
}
