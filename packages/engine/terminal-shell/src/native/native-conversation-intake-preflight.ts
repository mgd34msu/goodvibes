import { NativeActionPreflight } from './native-action-preflight.js';
import type { NativeConversationIntakeState } from './native-conversation-intake.js';
export class NativeConversationIntakePreflight extends NativeActionPreflight<NativeConversationIntakeState> {
  constructor(identity: () => string, invalidate: () => void) {
    super(identity, invalidate, {
      releaseOnClose: true,
      busy: () => ({ status: 'pending', message: 'A native intake action is already in progress.' }),
      unavailable: () => ({ status: 'unavailable', message: 'Native intake workspace or host is unavailable.' }),
    });
  }
}
